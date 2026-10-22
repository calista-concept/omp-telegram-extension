import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

const BOT_TOKEN = process.env.OMP_TELEGRAM_BOT_TOKEN;
// Telegram user id allowed to control the bot. Set OMP_TELEGRAM_USER_ID; the
// fallback keeps the author's personal setup working without it.
const ALLOWED_USER_ID = Number(process.env.OMP_TELEGRAM_USER_ID ?? 1087156700);

// Shared registry so multiple OMP instances coordinate who polls Telegram.
// Telegram's getUpdates allows only one poller per bot token, so instances
// elect a leader (activePid); standbys watch the registry and take over if
// the leader dies.
const REGISTRY_DIR = path.join(os.homedir(), ".omp");
const REGISTRY_PATH = path.join(REGISTRY_DIR, "telegram-bridge.json");

// Every Bot API request gets a hard deadline: a hung long-poll or POST must
// never freeze the poll loop or an event handler.
const API_TIMEOUT_MS = 35_000;

// Task currently running in an instance, published so every instance (and
// therefore /status and /stop from Telegram) can see terminal-started tasks.
type RegistryTask = {
  prompt: string;
  startedAt: number;
};

// Ask polls currently open in an instance. The Telegram poller (which may be
// a different instance) uses these to route button taps to the instance that
// actually runs the task.
type RegistryAskPoll = {
  toolCallId: string;
  questionId: string;
};

// One-shot command delivered to an instance via the registry and consumed by
// its watchdog tick.
type RegistryInbox =
  | { kind: "stop" }
  | { kind: "ask_answer"; questionId: string; optionIndex: number }
  | { kind: "ask_dismiss" };

type RegistryInstance = {
  name: string;
  cwd: string;
  startedAt: number;
  heartbeat: number;
  task?: RegistryTask | null;
  askPolls?: RegistryAskPoll[];
  inbox?: RegistryInbox | null;
};

type Registry = {
  activePid: number | null;
  offset: number;
  lastChatId: number | null;
  instances: Record<string, RegistryInstance>;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    from?: {
      id: number;
    };
    chat: {
      id: number;
    };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message: { chat: { id: number } };
    data?: string;
  };
};

type AgentEndEvent = {
  messages?: Array<{
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  }>;
  // The run is not really over: a follow-up run continues it (queued
  // messages, pending async work). The task must stay tracked.
  willContinue?: boolean;
  awaitingAsyncWork?: boolean;
};

type BeforeAgentStartEvent = {
  prompt?: unknown;
};

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

// GitHub-flavored Markdown → Telegram HTML (parse_mode: "HTML"). Telegram
// renders <b>, <i>, <s>, <code>, <pre> (class="language-x" gives syntax
// highlighting), <a> and <blockquote>. All source text is HTML-escaped first,
// so only tags generated here are active. If Telegram still rejects the
// result, the send site falls back to the raw plain text.
function markdownToTelegramHtml(markdown: string): string {
  const htmlEscape = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  // Fenced code blocks become <pre><code class="language-x"> placeholders so
  // their content skips the inline transforms below.
  const blocks: string[] = [];
  const codeBlockHtml = (info: string, code: string) => {
    const language = info.trim().split(/\s+/)[0] ?? "";
    const classAttr = language ? ` class="language-${language}"` : "";
    return `<pre><code${classAttr}>${htmlEscape(code.replace(/\n$/, ""))}</code></pre>`;
  };

  let text = markdown.replace(
    /```([^\n`]*)\n([\s\S]*?)```/g,
    (_match, info: string, code: string) => {
      blocks.push(codeBlockHtml(info, code));
      return `\u0000B${blocks.length - 1}\u0000`;
    },
  );

  // An unterminated fence (model got cut off mid-block): the rest of the
  // message is code.
  const dangling = text.match(/```([^\n`]*)\n?([\s\S]*)$/);
  if (dangling) {
    blocks.push(codeBlockHtml(dangling[1], dangling[2]));
    text = text.replace(/```([^\n`]*)\n?([\s\S]*)$/, `\u0000B${blocks.length - 1}\u0000`);
  }

  text = htmlEscape(text);

  return text
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/^(\s*)[-*+]\s+/gm, "$1• ")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_match, label: string, url: string) =>
        `<a href="${url.replace(/"/g, "%22")}">${label}</a>`,
    )
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<i>$2</i>")
    .replace(/(^|[^\w])_([^_\n]+)_(?![\w])/g, "$1<i>$2</i>")
    .replace(/\u0000B(\d+)\u0000/g, (_match, index: string) =>
      blocks[Number(index)] ?? "",
    );
}

// Split at line boundaries, never inside a fenced code block, so each chunk
// converts to balanced HTML.
function splitMarkdown(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    if (text.length - start <= limit) {
      chunks.push(text.slice(start));
      break;
    }

    const end = start + limit;
    let cut = -1;
    let inFence = false;
    let lineStart = start;

    while (lineStart < end) {
      const newline = text.indexOf("\n", lineStart);
      const lineEnd = newline === -1 ? text.length : newline;
      if (text.slice(lineStart, lineEnd).trimStart().startsWith("```")) {
        inFence = !inFence;
      }
      const candidate = lineEnd + 1;
      if (!inFence && candidate <= end && candidate > start) {
        cut = candidate;
      }
      if (newline === -1) {
        break;
      }
      lineStart = newline + 1;
    }

    if (cut <= start) {
      cut = end;
    }
    chunks.push(text.slice(start, cut));
    start = cut;
  }

  return chunks;
}

function readRegistry(): Registry {
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Registry;
    return {
      activePid: parsed.activePid ?? null,
      offset: parsed.offset ?? 0,
      lastChatId: parsed.lastChatId ?? null,
      instances: parsed.instances ?? {},
    };
  } catch {
    return { activePid: null, offset: 0, lastChatId: null, instances: {} };
  }
}

type RecentSession = {
  path: string;
  title: string;
  cwd: string;
  updatedAt: number;
};

// Scan ~/.omp/agent/sessions for recent session files. Each .jsonl begins
// with a "title" entry and a "session" entry carrying cwd; the file mtime
// says when it was last active.
function listRecentSessions(limit: number): RecentSession[] {
  const root = path.join(os.homedir(), ".omp", "agent", "sessions");
  const results: RecentSession[] = [];

  const walk = (dir: string) => {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!dirent.name.endsWith(".jsonl")) {
        continue;
      }

      let title = "";
      let cwd = "";
      try {
        const fd = openSync(full, "r");
        const buffer = Buffer.alloc(8192);
        const read = readSync(fd, buffer, 0, 8192, 0);
        closeSync(fd);
        const head = buffer.toString("utf8", 0, read);
        for (const line of head.split("\n")) {
          if (!line.trim()) {
            continue;
          }
          try {
            const entry = JSON.parse(line) as {
              type?: string;
              title?: string;
              cwd?: string;
            };
            if (entry.type === "title") {
              title = entry.title ?? "";
            }
            if (entry.type === "session") {
              cwd = entry.cwd ?? "";
            }
          } catch {
            continue;
          }
          if (title && cwd) {
            break;
          }
        }
      } catch {
        continue;
      }

      try {
        results.push({
          path: full,
          title: title || dirent.name,
          cwd,
          updatedAt: statSync(full).mtimeMs,
        });
      } catch {
        continue;
      }
    }
  };

  walk(root);
  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results.slice(0, limit);
}

function writeRegistry(registry: Registry): void {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  const tmpPath = `${REGISTRY_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2));
  renameSync(tmpPath, REGISTRY_PATH);
}

function updateRegistry(mutate: (registry: Registry) => void): Registry {
  const registry = readRegistry();
  mutate(registry);
  writeRegistry(registry);
  return registry;
}

// Single machine: liveness is the pid, nothing else.
function pruneDeadInstances(registry: Registry): void {
  for (const pidKey of Object.keys(registry.instances)) {
    const pid = Number(pidKey);
    if (pid !== process.pid && !isPidAlive(pid)) {
      delete registry.instances[pidKey];
    }
  }
}

export default function (pi: ExtensionAPI) {
  if (!BOT_TOKEN) {
    console.error("[telegram] Missing OMP_TELEGRAM_BOT_TOKEN");
    return;
  }

  // Instance identity for the shared registry.
  const myPid = process.pid;
  const myName = `${path.basename(process.cwd())} (${myPid})`;
  const myStartedAt = Date.now();

  let offset = 0;
  let lastSeenChatId: number | null = null;
  let pollLoopActive = false;
  let running = true;
  // First-ever run with an empty registry: skip the pending update backlog
  // instead of replaying up to 24h of old messages.
  let skipBacklog = false;

  let activeChatId: number | null = null;
  let activeTask: string | null = null;
  let activeTaskStartedAt: number | null = null;

  // Current OMP session context.
  let ompContext: ExtensionContext | null = null;

  // Todo plan progress, reported to Telegram as one message that gets edited
  // as items complete. The plan is captured from the `todo` tool's
  // tool_result (details.phases) while a Telegram-initiated task runs.
  type TodoTask = { content: string; status: string; blocker?: string };
  type TodoPhase = { name: string; tasks: TodoTask[] };

  const PLAN_SIG_BASE = "📋 Agent plan";
  const STATUS_ICON: Record<string, string> = {
    pending: "⬜",
    in_progress: "🔄",
    completed: "✅",
    abandoned: "❌",
    blocked: "🚫",
  };

  let planChatId: number | null = null;
  let planMessageId: number | null = null;
  let planSignature: string | null = null;

  function formatPlan(phases: TodoPhase[]): string {
    const lines: string[] = [];

    for (const phase of phases) {
      if (phase.tasks.length === 0) {
        continue;
      }

      if (phases.length > 1) {
        lines.push("", `▸ ${phase.name}`);
      }

      for (const task of phase.tasks) {
        const icon = STATUS_ICON[task.status] ?? "⬜";
        lines.push(`${icon} ${task.content}`);
        if (task.status === "blocked" && task.blocker) {
          lines.push(`   ↳ blocked: ${task.blocker}`);
        }
      }
    }

    return lines.join("\n");
  }

  // Only send/edit when the rendered plan actually changed; the todo tool
  // fires many times with identical state (heartbeats, no-op updates).
  function planHasChanged(phases: TodoPhase[]): boolean {
    const signature = JSON.stringify(
      phases.map((phase) => ({
        n: phase.name,
        t: phase.tasks.map((task) => [task.content, task.status]),
      })),
    );
    if (signature === planSignature) {
      return false;
    }
    planSignature = signature;
    return true;
  }

  async function handleTodoPhases(phases: TodoPhase[]): Promise<void> {
    const active = phases.filter((phase) => phase.tasks.length > 0);
    if (active.length === 0) {
      return;
    }

    if (!planChatId || planChatId !== activeChatId) {
      return;
    }

    if (!planHasChanged(active)) {
      return;
    }

    const total = active.reduce((sum, phase) => sum + phase.tasks.length, 0);
    const done = active.reduce(
      (sum, phase) =>
        sum +
        phase.tasks.filter(
          (task) =>
            task.status === "completed" || task.status === "abandoned",
        ).length,
      0,
    );

    const body = formatPlan(active);
    const header =
      done === total
        ? `${PLAN_SIG_BASE} — done (${done}/${total}) ✅`
        : `${PLAN_SIG_BASE} (${done}/${total})`;
    const text = `${header}\n${body}`;

    if (planMessageId === null) {
      planMessageId = await sendMessage(planChatId, text);
      console.log("[telegram] Plan message sent");
    } else {
      await editMessage(planChatId, planMessageId, text);
      console.log("[telegram] Plan message updated");
    }
  }

  function resetPlanTracking(): void {
    planChatId = null;
    planMessageId = null;
    planSignature = null;
  }

  // Acknowledge a callback query so Telegram clears the button spinner.
  async function answerCallback(callbackId: string): Promise<void> {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackId }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (error) {
      console.error("[telegram] answerCallbackQuery error:", error);
    }
  }

  // Inline keyboard taps. Callback data shapes:
  //   inst:<index>  — /instances buttons -> same logic as /use <index>
  //   sess:<index>  — /sessions buttons  -> same logic as /resume <index>
  async function handleCallback(callback: NonNullable<
    TelegramUpdate["callback_query"]
  >): Promise<void> {
    const data = callback.data ?? "";
    console.log(`[telegram] Callback: ${data}`);

    if (callback.from.id !== ALLOWED_USER_ID) {
      await answerCallback(callback.id);
      return;
    }

    const chatId = callback.message?.chat.id;
    if (!chatId) {
      await answerCallback(callback.id);
      return;
    }
    lastSeenChatId = chatId;

    if (data.startsWith("inst:")) {
      await answerCallback(callback.id);
      await switchToInstance(chatId, Number.parseInt(data.slice(5), 10));
      return;
    }
    if (data.startsWith("sess:")) {
      await answerCallback(callback.id);
      await resumeSession(chatId, Number.parseInt(data.slice(5), 10));
      return;
    }
    if (data.startsWith("ask:")) {
      await answerCallback(callback.id);
      await dispatchAskCallback(chatId, data.slice(4));
      return;
    }

    await answerCallback(callback.id);
  }

  // "questionId:optionIndex" or "dismiss".
  async function dispatchAskCallback(
    chatId: number,
    payload: string,
  ): Promise<void> {
    if (payload === "dismiss") {
      if (askPolls.size > 0) {
        for (const toolCallId of [...askPolls.keys()]) {
          await closeAskPoll(toolCallId, "_Closed manually — the answer was given in the terminal._");
        }
        return;
      }

      // No local polls: the task (and its poll) lives in another instance.
      relayAskInbox({ kind: "ask_dismiss" });
      await sendMessage(chatId, "📨 Dismiss relayed to the instance running the task.");
      return;
    }

    const separator = payload.lastIndexOf(":");
    if (separator === -1) {
      return;
    }

    const questionId = payload.slice(0, separator);
    const optionIndex = Number.parseInt(payload.slice(separator + 1), 10);
    if (Number.isNaN(optionIndex)) {
      return;
    }

    await handleAskCallback(chatId, questionId, optionIndex);
  }

  // Deliver an ask-related inbox command to the instance(s) that advertise
  // the matching poll (or any task, for dismiss). Returns true when relayed.
  function relayAskInbox(
    command: { kind: "ask_answer"; questionId: string; optionIndex: number } | { kind: "ask_dismiss" },
  ): boolean {
    const live = listLiveInstances();
    const targets =
      command.kind === "ask_answer"
        ? live.filter(
            (instance) =>
              instance.pid !== myPid &&
              instance.askPolls?.some(
                (poll) => poll.questionId === command.questionId,
              ),
          )
        : live.filter(
            (instance) =>
              instance.pid !== myPid && (instance.task ?? instance.askPolls?.length),
          );

    for (const target of targets) {
      updateRegistry((reg) => {
        const entry = reg.instances[String(target.pid)];
        if (entry) {
          entry.inbox = command;
        }
      });
    }
    return targets.length > 0;
  }

  // Shared by "/use <n>" and the instance buttons.
  async function switchToInstance(
    chatId: number,
    targetIndex: number,
  ): Promise<void> {
    if (Number.isNaN(targetIndex) || targetIndex < 1) {
      await sendMessage(
        chatId,
        "Usage: /use <number> — see /instances for the list.",
      );
      return;
    }

    const live = listLiveInstances();
    const target = live[targetIndex - 1];

    if (!target) {
      await sendMessage(chatId, [
        `❌ No instance number ${targetIndex}. See /instances.`,
        "",
        "Only omp instances running this Telegram bridge are listed. Instances started before the bridge was added (or before their last restart) don't appear — restart omp to register them.",
      ].join("\n"));
      return;
    }

    if (target.pid === myPid) {
      await sendMessage(
        chatId,
        `🟢 "${target.name}" is already the active instance.`,
      );
      return;
    }

    updateRegistry((reg) => {
      reg.activePid = target.pid;
      reg.lastChatId = chatId;
    });
    pollLoopActive = false;

    await sendMessage(
      chatId,
      `🔁 Switching to "${target.name}". It will take over Telegram control within a few seconds.`,
    );
    console.log(`[telegram] Handed Telegram control to ${target.name}`);
  }

  // Session switching needs the COMMAND context. omp gives
  // newSession/switchSession/waitForIdle only to registerCommand handlers
  // (createCommandContext); event-handler contexts (pi.on) lack them. So we
  // register a small omp command whose handler stashes its context here.
  // The command context is a superset of the event context and its closures
  // stay bound to the live session, so one cached capture keeps working.
  type SessionOpsContext = ExtensionContext & {
    waitForIdle?: () => Promise<void>;
    newSession?: (options?: unknown) => Promise<{ cancelled?: boolean } | undefined>;
    switchSession?: (sessionPath: string) => Promise<boolean | undefined | { cancelled?: boolean }>;
  };

  let sessionOpsContext: SessionOpsContext | null = null;

  function hasSessionOps(ctx: SessionOpsContext | null): boolean {
    return (
      ctx !== null &&
      typeof ctx.switchSession === "function" &&
      typeof ctx.newSession === "function"
    );
  }

  type PendingSessionOp =
    | { kind: "new"; chatId: number }
    | { kind: "resume"; chatId: number; targetIndex: number };

  let pendingSessionOp: PendingSessionOp | null = null;

  pi.registerCommand("tg", {
    description:
      "Telegram bridge: capture the command context (enables /resume and /new from Telegram).",
    async handler(_args, ctx) {
      sessionOpsContext = ctx as SessionOpsContext;
      console.log("[telegram] Command context captured via /tg");

      const pending = pendingSessionOp;
      pendingSessionOp = null;
      if (!pending) {
        return;
      }

      if (pending.kind === "new") {
        await startNewSession(pending.chatId);
      } else {
        await resumeSession(pending.chatId, pending.targetIndex);
      }
    },
  });

  const BOOTSTRAP_HINT = [
    "⚠️ Session switching isn't armed in this instance yet.",
    "",
    "Run `/tg` once in this instance's terminal — it arms Telegram control (session switching needs omp's command context, which only a command handler gets).",
    "Your pending command will run right after.",
  ].join("\n");

  async function armOrQueue(op: PendingSessionOp, chatId: number): Promise<void> {
    pendingSessionOp = op;
    await sendMessage(chatId, BOOTSTRAP_HINT);
  }

  // Shared by "/resume <n>" and the session buttons.
  async function resumeSession(
    chatId: number,
    targetIndex: number,
  ): Promise<void> {
    const idle = ompContext?.isIdle() ?? true;

    if (!idle) {
      await sendMessage(
        chatId,
        "⚠️ OMP is still working on a task. Send /stop first if you want to abandon it, then /resume.",
      );
      return;
    }

    if (!hasSessionOps(sessionOpsContext)) {
      await armOrQueue({ kind: "resume", chatId, targetIndex }, chatId);
      return;
    }

    if (Number.isNaN(targetIndex) || targetIndex < 1) {
      await sendMessage(
        chatId,
        "Usage: /resume <number> — see /sessions for the list.",
      );
      return;
    }

    const sessions = listRecentSessions(15);
    const target = sessions[targetIndex - 1];

    if (!target) {
      await sendMessage(
        chatId,
        `❌ No session number ${targetIndex}. See /sessions.`,
      );
      return;
    }

    try {
      const ops = sessionOpsContext as SessionOpsContext & {
        switchSession: (path: string) => Promise<boolean | undefined | { cancelled?: boolean }>;
      };
      const result = await ops.switchSession(target.path);
      const cancelled =
        result === false ||
        (result !== undefined && result !== null && typeof result === "object" && result.cancelled === true);
      if (cancelled) {
        await sendMessage(
          chatId,
          `❌ OMP refused to switch to "${target.title}".`,
        );
        return;
      }

      resetPlanTracking();
      await sendMessage(
        chatId,
        [
          `🔁 Switched to session:`,
          `**${target.title}**`,
          "",
          `📁 ${target.cwd}`,
        ].join("\n"),
      );
      console.log(`[telegram] Switched session: ${target.title}`);
    } catch (error) {
      console.error("[telegram] switchSession failed:", error);
      sessionOpsContext = null;
      await sendMessage(
        chatId,
        `❌ Failed to switch session.\n\n${String(error)}`,
      );
    }
  }

  // /new: fresh session in this instance.
  async function startNewSession(chatId: number): Promise<void> {
    const idle = ompContext?.isIdle() ?? true;

    if (!idle) {
      await sendMessage(
        chatId,
        "⚠️ OMP is still working on a task. Send /stop first, then /new.",
      );
      return;
    }

    if (!hasSessionOps(sessionOpsContext)) {
      await armOrQueue({ kind: "new", chatId }, chatId);
      return;
    }

    try {
      const ops = sessionOpsContext as SessionOpsContext & {
        newSession: () => Promise<{ cancelled?: boolean } | undefined>;
      };
      const result = await ops.newSession();
      if (result?.cancelled) {
        await sendMessage(chatId, "❌ OMP refused to start a new session.");
        return;
      }

      resetPlanTracking();
      await sendMessage(
        chatId,
        "✨ New session started. This instance is now blank — send a prompt to begin.",
      );
      console.log("[telegram] New session started via Telegram");
    } catch (error) {
      console.error("[telegram] newSession failed:", error);
      sessionOpsContext = null;
      await sendMessage(
        chatId,
        `❌ Failed to start a new session.\n\n${String(error)}`,
      );
    }
  }

  function formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    }

    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
  }

  // One HTTP POST to sendMessage. Returns the delivered message_id or null.
  // A null return after parse_mode HTML means "Telegram refused the markup"
  // (or a network error); the caller retries in plain text.
  async function postToTelegram(
    chatId: number,
    text: string,
    parseMode: boolean,
    replyMarkup?: unknown,
  ): Promise<number | null> {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
          body: JSON.stringify({
            chat_id: chatId,
            text,
            ...(parseMode ? { parse_mode: "HTML" } : {}),
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          }),
        },
      );

      if (!response.ok) {
        console.error(
          "[telegram] sendMessage failed:",
          await response.text(),
        );
        return null;
      }

      const data = (await response.json()) as {
        ok: boolean;
        result?: { message_id?: number };
      };
      return data.ok && data.result?.message_id
        ? data.result.message_id
        : null;
    } catch (error) {
      console.error("[telegram] sendMessage error:", error);
      return null;
    }
  }

  async function postEdit(
    chatId: number,
    messageId: number,
    text: string,
    parseMode: boolean,
  ): Promise<boolean> {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text,
            ...(parseMode ? { parse_mode: "HTML" } : {}),
          }),
        },
      );

      if (!response.ok) {
        console.error(
          "[telegram] editMessage failed:",
          await response.text(),
        );
        return false;
      }
      return true;
    } catch (error) {
      console.error("[telegram] editMessage error:", error);
      return false;
    }
  }

  type InlineButton = { text: string; callback_data: string };

  // Returns the sent message's id so callers can edit it later. Chunks are
  // split on line boundaries outside code fences, converted to Telegram HTML
  // (Markdown rendering + syntax highlighting), and resent as plain text if
  // Telegram rejects the HTML.
  async function sendMessage(
    chatId: number,
    text: string,
    keyboard?: InlineButton[][],
  ): Promise<number | null> {
    const chunks = splitMarkdown(text, 3500);
    let lastMessageId: number | null = null;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const html = markdownToTelegramHtml(chunk);
      // Attach the keyboard only to the final chunk.
      const replyMarkup =
        keyboard && i === chunks.length - 1
          ? { inline_keyboard: keyboard }
          : undefined;
      let messageId = await postToTelegram(chatId, html, true, replyMarkup);
      if (messageId === null) {
        messageId = await postToTelegram(
          chatId,
          chunk,
          false,
          replyMarkup,
        );
      }
      if (messageId !== null) {
        lastMessageId = messageId;
      }
    }

    return lastMessageId;
  }

  async function editMessage(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<void> {
    const html = markdownToTelegramHtml(text);
    const edited = await postEdit(chatId, messageId, html, true);
    if (!edited) {
      await postEdit(chatId, messageId, text.slice(0, 4000), false);
    }
  }

  function listLiveInstances(): Array<{
    pid: number;
    name: string;
    cwd: string;
    startedAt: number;
    task: RegistryTask | null;
    askPolls: RegistryAskPoll[];
  }> {
    const registry = updateRegistry((reg) => {
      pruneDeadInstances(reg);
    });

    return Object.entries(registry.instances)
      .map(([pidKey, instance]) => ({
        pid: Number(pidKey),
        name: instance.name,
        cwd: instance.cwd,
        startedAt: instance.startedAt,
        task: instance.task ?? null,
        askPolls: instance.askPolls ?? [],
      }))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  // Capture the live OMP context.
  pi.on("session_start", async (_event, ctx) => {
    ompContext = ctx;
    console.log("[telegram] OMP context captured");
  });

  // ── Registry task/ask-poll publication ──────────────────────────────────
  // Every instance publishes its running task and open ask polls so the
  // Telegram poller (which may be another instance) can see and route them.

  function setRegistryTask(task: RegistryTask | null): void {
    updateRegistry((reg) => {
      const self = reg.instances[String(myPid)];
      if (self) {
        self.task = task;
      }
    });
  }

  function syncRegistryAskPolls(): void {
    const polls = [...askPolls.entries()].map(([toolCallId, poll]) => ({
      toolCallId,
      questionId: poll.questions[0]?.id ?? "",
    }));
    updateRegistry((reg) => {
      const self = reg.instances[String(myPid)];
      if (self) {
        self.askPolls = polls;
      }
    });
  }

  // Route a stop command: local abort, or an inbox message for the instance
  // that actually runs the task.
  async function stopTask(chatId: number): Promise<void> {
    if (activeTask) {
      await stopLocalTask(chatId);
      return;
    }

    const live = listLiveInstances().filter(
      (instance) => instance.task && instance.pid !== myPid,
    );

    if (live.length === 0) {
      await sendMessage(
        chatId,
        "⚪ OMP is already idle.\n\nThere is no active task to stop.",
      );
      return;
    }

    for (const instance of live) {
      updateRegistry((reg) => {
        const target = reg.instances[String(instance.pid)];
        if (target) {
          target.inbox = { kind: "stop" };
        }
      });
    }

    await sendMessage(
      chatId,
      `🛑 Stop signal sent to ${live.length === 1 ? `"${live[0].name}"` : `${live.length} instances`}.`,
    );
  }

  // Abort this instance's agent. Called from /stop (own task) and from the
  // watchdog when another instance relayed a stop via the registry inbox.
  async function stopLocalTask(chatId: number | null): Promise<void> {
    const task = activeTask;
    const elapsed = activeTaskStartedAt
      ? formatDuration(Date.now() - activeTaskStartedAt)
      : "unknown";

    if (!ompContext) {
      if (chatId !== null) {
        await sendMessage(
          chatId,
          "❌ I couldn't access the OMP session context, so I can't safely stop the agent.",
        );
      }
      return;
    }

    try {
      // Abort the actual OMP agent operation.
      ompContext.abort();

      if (chatId !== null) {
        await sendMessage(
          chatId,
          [
            "🛑 OMP task stopped",
            "",
            `⏱ Ran for: ${elapsed}`,
            "",
            "📋 Task:",
            task ?? "Unknown task",
          ].join("\n"),
        );
      }

      console.log("[telegram] OMP task aborted");

      activeChatId = null;
      activeTask = null;
      activeTaskStartedAt = null;
      resetPlanTracking();
      setRegistryTask(null);
    } catch (error) {
      console.error("[telegram] Failed to abort OMP:", error);

      if (chatId !== null) {
        await sendMessage(
          chatId,
          `❌ Failed to stop OMP.\n\n${String(error)}`,
        );
      }
    }
  }

  async function poll() {
    console.log("[telegram] Polling started");

    while (running) {
      // Standby: another instance owns the Telegram poller.
      if (readRegistry().activePid !== myPid) {
        pollLoopActive = false;
        await sleep(2000);
        continue;
      }

      if (!pollLoopActive) {
        pollLoopActive = true;
        console.log("[telegram] This instance is the active poller");
      }

      try {
        if (skipBacklog) {
          const response = await fetch(
            `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=-1`,
            { signal: AbortSignal.timeout(API_TIMEOUT_MS) },
          );

          if (response.ok) {
            const data = (await response.json()) as {
              ok: boolean;
              result?: TelegramUpdate[];
            };

            if (data.ok && data.result && data.result.length > 0) {
              const last = data.result[data.result.length - 1];
              offset = last.update_id + 1;
              updateRegistry((reg) => {
                reg.offset = offset;
              });
            }
          }

          skipBacklog = false;
          continue;
        }

        const response = await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=10&offset=${offset}`,
          // 10s long-poll + margin; the hard deadline keeps the loop alive
          // even if the socket never resolves.
          { signal: AbortSignal.timeout(API_TIMEOUT_MS) },
        );

        if (response.status === 409) {
          // Another process is polling. This is expected only during a
          // handover window; a persistent conflict means the registry and
          // reality disagree, so defer to the registry.
          console.error(
            "[telegram] getUpdates conflict — another instance may be polling",
          );

          if (readRegistry().activePid !== myPid) {
            pollLoopActive = false;
            console.log("[telegram] Lost the poller role to another instance");
            continue;
          }

          await sleep(2000);
          continue;
        }

        if (!response.ok) {
          console.error(
            "[telegram] getUpdates failed:",
            await response.text(),
          );

          await sleep(3000);
          continue;
        }

        const data = (await response.json()) as {
          ok: boolean;
          result?: TelegramUpdate[];
        };

        if (!data.ok || !data.result) {
          await sleep(2000);
          continue;
        }

        // Another instance may have claimed the poller while this long-poll
        // was open; drop the batch instead of acting as a rogue poller.
        if (readRegistry().activePid !== myPid) {
          if (data.result.length > 0) {
            const lastUpdateId = data.result[data.result.length - 1].update_id;
            offset = lastUpdateId + 1;
            updateRegistry((reg) => {
              reg.offset = offset;
            });
          }
          continue;
        }

        for (const update of data.result) {
          offset = update.update_id + 1;

          // Inline keyboard taps arrive as callback_query updates.
          const callback = update.callback_query;
          if (callback) {
            await handleCallback(callback);
            continue;
          }

          const message = update.message;

          if (!message?.text || !message.from) {
            continue;
          }

          if (message.from.id === ALLOWED_USER_ID) {
            lastSeenChatId = message.chat.id;
          }

          // Only your Telegram account can control OMP.
          if (message.from.id !== ALLOWED_USER_ID) {
            console.log(
              `[telegram] Ignoring unauthorized user ${message.from.id}`,
            );
            continue;
          }

          const text = message.text.trim();
          const chatId = message.chat.id;
          const command = text.toLowerCase();

          console.log(`[telegram] Received: ${text}`);

          // Connection test.
          if (command === "/start" || command === "hello") {
            await sendMessage(
              chatId,
              "🤖 OMP Telegram bridge is working!",
            );
            continue;
          }

          // STATUS
          if (command === "/status") {
            const live = listLiveInstances();
            const busyLines: string[] = [];

            for (const instance of live) {
              if (instance.pid === myPid) {
                if (activeTask && activeTaskStartedAt) {
                  busyLines.push(
                    [
                      `🟢 ${instance.name} (this instance)`,
                      `   📋 ${activeTask.length > 300 ? `${activeTask.slice(0, 300)}…` : activeTask}`,
                      `   ⏱ ${formatDuration(Date.now() - activeTaskStartedAt)}`,
                    ].join("\n"),
                  );
                }
              } else if (instance.task) {
                const prompt = instance.task.prompt;
                busyLines.push(
                  [
                    `🟢 ${instance.name}`,
                    `   📋 ${prompt.length > 300 ? `${prompt.slice(0, 300)}…` : prompt}`,
                    `   ⏱ ${formatDuration(Date.now() - instance.task.startedAt)}`,
                    `   📁 ${instance.cwd}`,
                  ].join("\n"),
                );
              }
            }

            if (busyLines.length > 0) {
              await sendMessage(
                chatId,
                [
                  "📊 OMP Status — working",
                  "",
                  ...busyLines,
                  "",
                  "Send /stop to cancel, /instances for the full list.",
                ].join("\n"),
              );
            } else {
              await sendMessage(
                chatId,
                [
                  "⚪ OMP Status",
                  "",
                  "Status: Idle",
                  "",
                  "No task is currently running in any instance.",
                ].join("\n"),
              );
            }

            continue;
          }

          // STOP
          if (command === "/stop") {
            await stopTask(chatId);
            continue;
          }

          // INSTANCES: list live OMP instances.
          if (command === "/instances") {
            const live = listLiveInstances();
            const registry = readRegistry();

            const lines = ["🖥 OMP instances", ""];

            live.forEach((instance, index) => {
              const isActive = instance.pid === registry.activePid;
              const isSelf = instance.pid === myPid;
              const marker = isActive ? "🟢" : "⚪";
              const labels = [
                isActive ? "active" : "standby",
                isSelf ? "this instance" : null,
              ]
                .filter(Boolean)
                .join(" · ");

              lines.push(`${marker} ${index + 1}. ${instance.name} — ${labels}`);
              lines.push(
                `   ${instance.cwd} · up ${formatDuration(Date.now() - instance.startedAt)}`,
              );

              const busyTask =
                isSelf && activeTask
                  ? activeTask
                  : instance.task?.prompt;
              if (busyTask) {
                lines.push(
                  `   ⚙️ busy: ${busyTask.length > 120 ? `${busyTask.slice(0, 120)}…` : busyTask}`,
                );
              }
            });

            const keyboard = live
              .filter((instance) => instance.pid !== registry.activePid)
              .map((instance, index) => [
                {
                  text: `Switch to ${instance.name}`,
                  callback_data: `inst:${live.indexOf(instance) + 1}`,
                },
              ]);

            lines.push("", "Tap a button or send /use <number>");
            await sendMessage(chatId, lines.join("\n"), keyboard);
            continue;
          }

          // USE: hand Telegram control to another instance.
          if (command.startsWith("/use")) {
            const arg = text.slice(4).trim();
            const targetIndex = Number.parseInt(arg, 10);
            await switchToInstance(chatId, targetIndex);
            continue;
          }

          // NEW: start a fresh session in this instance.
          if (command === "/new") {
            await startNewSession(chatId);
            continue;
          }

          // SESSIONS: list recent sessions with tap buttons.
          if (command === "/sessions") {
            const sessions = listRecentSessions(15);

            if (sessions.length === 0) {
              await sendMessage(
                chatId,
                "🗂 No recent sessions found in ~/.omp/agent/sessions.",
              );
              continue;
            }

            const lines = ["🗂 Recent sessions", ""];

            sessions.forEach((session, index) => {
              lines.push(
                `${index + 1}. **${session.title}**`,
                `   ${session.cwd} · ${formatDuration(Date.now() - session.updatedAt)} ago`,
              );
            });

            const keyboard = sessions.map((session, index) => [
              {
                text: `${index + 1}. ${session.title.slice(0, 40)}`,
                callback_data: `sess:${index + 1}`,
              },
            ]);

            lines.push("", "Tap a session or send /resume <number>");
            await sendMessage(chatId, lines.join("\n"), keyboard);
            continue;
          }

          // RESUME: switch this instance to a recent session.
          if (command.startsWith("/resume")) {
            const arg = text.slice(7).trim();
            const targetIndex = Number.parseInt(arg, 10);
            await resumeSession(chatId, targetIndex);
            continue;
          }

          // Normal Telegram → OMP prompt.
          activeChatId = chatId;
          activeTask = text;
          activeTaskStartedAt = Date.now();
          resetPlanTracking();
          planChatId = chatId;

          await sendMessage(
            chatId,
            `🔨 OMP started\n\n📋 ${text}`,
          );

          try {
            await pi.sendUserMessage(text);

            console.log("[telegram] Prompt sent to OMP");
          } catch (error) {
            console.error(
              "[telegram] Failed to send prompt to OMP:",
              error,
            );

            await sendMessage(
              chatId,
              `❌ Failed to send prompt to OMP.\n\n${String(error)}`,
            );

            activeChatId = null;
            activeTask = null;
            activeTaskStartedAt = null;
            resetPlanTracking();
          }
        }

        if (data.result.length > 0) {
          updateRegistry((reg) => {
            reg.offset = offset;
            if (lastSeenChatId !== null) {
              reg.lastChatId = lastSeenChatId;
            }
            const self = reg.instances[String(myPid)];
            if (self) {
              self.heartbeat = Date.now();
            }
          });
        }
      } catch (error) {
        console.error("[telegram] Polling error:", error);

        await sleep(3000);
      }
    }
  }

  // Todo plan progress: the `todo` tool's result carries details.phases with
  // every task's status. Push updates to the plan message while a
  // Telegram-initiated task is running in this instance.
  type ToolResultEvent = {
    toolName?: string;
    details?: { phases?: TodoPhase[] };
  };

  pi.on("tool_result", async (event) => {
    if (!activeChatId || !planChatId) {
      return;
    }

    const { toolName, details } = event as unknown as ToolResultEvent;
    if (toolName !== "todo" || !details?.phases) {
      return;
    }

    await handleTodoPhases(details.phases);
  });

  // ── Ask tool → Telegram poll ────────────────────────────────────────────
  // When the agent calls the `ask` tool (options for the user), the question
  // is mirrored to Telegram as a message with one button per option. The
  // poll closes automatically:
  //   - the user taps a button here (the selected label is what omp's ask
  //     dialog resolves first — Telegram wins), or
  //   - the tool_execution_end event arrives (answered in the terminal /
  //     another surface), or
  //   - the agent ends without an answer (poll marked closed).
  // The button tap itself cannot inject the answer into omp's native ask
  // dialog from an extension, so tapping sends the chosen label back as a
  // queued prompt ("answer to question ...: <label>") — the agent reads it
  // immediately after the ask tool resolves (e.g. when the terminal poll
  // timed out or was answered with the same label, this is the confirmation).
  type AskQuestion = {
    id: string;
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multi?: boolean;
    recommended?: number;
  };

  type ToolExecutionStartEvent = {
    toolCallId?: string;
    toolName?: string;
    args?: { questions?: AskQuestion[] };
  };

  type ToolExecutionEndEvent = {
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  };

  const askPolls = new Map<
    string,
    { chatId: number; messageId: number; questions: AskQuestion[] }
  >();

  function formatAskText(questions: AskQuestion[]): string {
    const lines = ["❓ **The agent needs your input**", ""];

    questions.forEach((question, index) => {
      const label =
        questions.length > 1 ? `**${index + 1}. ${question.question}**` : `**${question.question}**`;
      lines.push(label);

      question.options.forEach((option, optionIndex) => {
        const recommended =
          question.recommended === optionIndex ? " _(recommended)_" : "";
        lines.push(`• **${option.label}**${recommended}`);
        if (option.description) {
          lines.push(`   ${option.description}`);
        }
      });

      if (question.multi) {
        lines.push("_(multiple selection possible)_");
      }
    });

    lines.push(
      "",
      "_Answering here queues your choice for the agent. If you answer in the terminal instead, that answer wins and this poll closes automatically._",
    );
    return lines.join("\n");
  }

  function askKeyboard(questions: AskQuestion[]): InlineButton[][] {
    const rows: InlineButton[][] = [];
    const single = questions.length === 1;

    for (const question of questions) {
      for (let i = 0; i < question.options.length; i++) {
        const option = question.options[i];
        const prefix = single ? "" : `Q${questions.indexOf(question) + 1} · `;
        rows.push([
          {
            text: `${prefix}${option.label}`,
            callback_data: `ask:${question.id}:${i}`,
          },
        ]);
      }
    }

    rows.push([{ text: "✅ Answered in terminal", callback_data: "ask:dismiss" }]);
    return rows;
  }

  pi.on("tool_execution_start", async (event) => {
    const { toolName, args, toolCallId } =
      event as unknown as ToolExecutionStartEvent;
    if (toolName !== "ask" || !toolCallId || !activeChatId) {
      return;
    }

    const questions = args?.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      return;
    }

    const messageId = await sendMessage(
      activeChatId,
      formatAskText(questions),
      askKeyboard(questions),
    );

    if (messageId !== null) {
      askPolls.set(toolCallId, {
        chatId: activeChatId,
        messageId,
        questions,
      });
      syncRegistryAskPolls();
      console.log(`[telegram] Ask poll sent for ${toolCallId}`);
    }
  });

  function renderAskEdit(questions: AskQuestion[]): string {
    const lines = ["🗳 **Poll closed**", ""];
    lines.push(
      questions.map((question) => question.question).join("\n"),
    );
    lines.push("", "_Answered from the terminal, or superseded._");
    return lines.join("\n");
  }

  async function closeAskPoll(toolCallId: string, note: string): Promise<void> {
    const poll = askPolls.get(toolCallId);
    if (!poll) {
      return;
    }
    askPolls.delete(toolCallId);
    syncRegistryAskPolls();

    await editMessage(
      poll.chatId,
      poll.messageId,
      [
        "🗳 **Poll closed**",
        "",
        renderAskEdit(poll.questions),
        "",
        note,
      ].join("\n"),
    );
  }

  pi.on("tool_execution_end", async (event) => {
    const { toolCallId, toolName } =
      event as unknown as ToolExecutionEndEvent;
    if (toolName !== "ask" || !toolCallId) {
      return;
    }

    await closeAskPoll(
      toolCallId,
      "_Answered in the terminal — the agent continues with that answer._",
    );
  });

  // Ask-poll cleanup on agent end: any open polls are dead (tool result
  // consumed with "cancelled" or the run finished). Own handler — omp's
  // extension runner calls every registered handler for the event.
  pi.on("agent_end", async () => {
    for (const toolCallId of [...askPolls.keys()]) {
      await closeAskPoll(
        toolCallId,
        "_The agent finished without an answer to this question._",
      );
    }
  });

  // Tap on an ask poll button.
  async function handleAskCallback(
    chatId: number,
    questionId: string,
    optionIndex: number,
  ): Promise<void> {
    for (const [toolCallId, poll] of askPolls) {
      const question = poll.questions.find((q) => q.id === questionId);
      if (!question) {
        continue;
      }

      const option = question.options[optionIndex];
      if (!option) {
        return;
      }

      await closeAskPoll(
        toolCallId,
        `✅ **You answered from Telegram:** ${option.label}`,
      );

      // Feed the choice back to the agent as an immediate queued message.
      await sendMessage(
        chatId,
        `📨 Sent to the agent: **${option.label}**`,
      );

      try {
        await pi.sendUserMessage(
          `Answer to question "${question.question}": ${option.label}`,
        );
        console.log(`[telegram] Ask answer sent: ${option.label}`);
      } catch (error) {
        console.error("[telegram] Failed to send ask answer:", error);
        await sendMessage(
          chatId,
          `❌ Failed to deliver the answer to OMP.\n\n${String(error)}`,
        );
      }
      return;
    }

    // Not a local poll: the running task (and its poll) belongs to another
    // instance — route the tap there through the registry inbox.
    const relayed = relayAskInbox({
      kind: "ask_answer",
      questionId,
      optionIndex,
    });
    if (relayed) {
      await sendMessage(
        chatId,
        "📨 Answer relayed to the instance running the task.",
      );
      return;
    }

    await sendMessage(
      chatId,
      "⚠️ This poll is no longer active (already answered or closed).",
    );
  }

  // ── Task tracking: any surface ──────────────────────────────────────────
  // before_agent_start fires for every agent run regardless of where the
  // prompt came from (terminal, Telegram, queued steering). Track the run
  // and notify Telegram even when the task was started elsewhere.
  pi.on("before_agent_start", async (event) => {
    const { prompt } = event as unknown as BeforeAgentStartEvent;
    const taskText =
      typeof prompt === "string" && prompt.trim()
        ? prompt.trim()
        : "(continued run)";

    activeTask = taskText;
    activeTaskStartedAt = Date.now();
    setRegistryTask({ prompt: taskText, startedAt: activeTaskStartedAt });

    // Telegram-initiated runs already announced themselves in the poll
    // handler and own the chat; only announce runs from other surfaces.
    if (activeChatId) {
      return;
    }

    const chatId = lastSeenChatId ?? readRegistry().lastChatId;
    if (chatId === null) {
      console.log(
        "[telegram] Terminal task started, but no Telegram chat is known yet",
      );
      return;
    }

    activeChatId = chatId;
    planChatId = chatId;
    resetPlanTracking();

    // Fire-and-forget: awaiting here would block omp's turn start (the
    // runner waits for this handler before the agent begins). The POST runs
    // detached; postToTelegram has its own timeout so it cannot hang.
    void sendMessage(
      chatId,
      [
        "🚀 OMP started (from the terminal)",
        "",
        `📋 ${taskText.length > 500 ? `${taskText.slice(0, 500)}…` : taskText}`,
        "",
        "Send /status for progress or /stop to cancel.",
      ].join("\n"),
    ).catch((error) =>
      console.error("[telegram] Start notification failed:", error),
    );
  });

  // Agent finished.
  pi.on("agent_end", async (event) => {
    const { willContinue, awaitingAsyncWork } =
      event as unknown as AgentEndEvent;

    // Not really done: a queued/follow-up run continues this task, or async
    // work (subagents, detached jobs) is still pending. Keep tracking.
    if ((willContinue || awaitingAsyncWork) && activeTask) {
      console.log(
        `[telegram] agent_end: continuation pending (willContinue=${willContinue}, awaitingAsyncWork=${awaitingAsyncWork}) — task stays active`,
      );
      return;
    }

    if (!activeChatId) {
      // Still clear registry state even if there is nobody to notify.
      setRegistryTask(null);
      return;
    }

    try {
      // pi's event type doesn't expose the transcript messages.
      const { messages } = event as unknown as AgentEndEvent;
      const allMessages = messages ?? [];

      const assistantMessages = allMessages.filter(
        (message) => message?.role === "assistant",
      );

      const lastAssistant = assistantMessages[assistantMessages.length - 1];

      if (!lastAssistant) {
        console.log("[telegram] agent_end: no assistant message");
        return;
      }

      let finalText = "";

      if (Array.isArray(lastAssistant.content)) {
        finalText = lastAssistant.content
          .filter((part) => part?.type === "text")
          .map((part) => part.text ?? "")
          .join("");
      }

      if (!finalText && typeof lastAssistant.content === "string") {
        finalText = lastAssistant.content;
      }

      finalText = finalText
        .trim()
        .replace(/\n{3,}/g, "\n\n");

      if (!finalText) {
        console.log("[telegram] agent_end: no final text");
        return;
      }

      const duration = activeTaskStartedAt
        ? formatDuration(Date.now() - activeTaskStartedAt)
        : "unknown";

      const task = activeTask ?? "Unknown task";

      const telegramMessage = [
        "✅ OMP finished",
        "",
        `⏱ ${duration}`,
        "",
        "📋 Task:",
        task,
        "",
        "📝 Result:",
        finalText,
      ].join("\n");

      await sendMessage(activeChatId, telegramMessage);

      console.log("[telegram] Final summary sent to Telegram");
    } catch (error) {
      console.error(
        "[telegram] Failed to process agent_end:",
        error,
      );

      if (activeChatId) {
        await sendMessage(
          activeChatId,
          `⚠️ OMP finished, but I couldn't create the completion message.\n\n${String(error)}`,
        );
      }
    } finally {
      activeChatId = null;
      activeTask = null;
      activeTaskStartedAt = null;
      resetPlanTracking();
      setRegistryTask(null);
    }
  });

  // Register this instance and claim leadership if no live instance holds it.
  updateRegistry((reg) => {
    pruneDeadInstances(reg);
    reg.instances[String(myPid)] = {
      name: myName,
      cwd: process.cwd(),
      startedAt: myStartedAt,
      heartbeat: Date.now(),
    };

    const activePid = reg.activePid;
    if (activePid === null || !isPidAlive(activePid)) {
      reg.activePid = myPid;
    }
  });

  // Notifications for tasks started outside Telegram go to the last chat
  // that talked to the bridge (survives restarts via the registry).
  lastSeenChatId = readRegistry().lastChatId;

  console.log(
    `[telegram] Instance ${myName} registered (${isLeader() ? "active poller" : "standby"})`,
  );

  function isLeader(): boolean {
    return readRegistry().activePid === myPid;
  }

  // Standbys adopt the shared offset when they take over.
  function adoptOffset(): void {
    offset = readRegistry().offset;
  }

  // Leader considered wedged when its heartbeat is this stale (watchdog
  // ticks every 3s; a live leader updates every tick). A hung getUpdates
  // socket used to freeze a leader forever — this lets standbys take over.
  const LEADER_STALE_MS = 30_000;

  function leaderHeartbeat(registry: Registry, pid: number): number {
    const entry = registry.instances[String(pid)];
    return entry ? entry.heartbeat : 0;
  }

  // Watchdog: standbys claim the poller role when the active instance dies
  // or freezes, notify the user about the failover, and consume this
  // instance's inbox commands (stop / ask answers relayed by the poller).
  const watchdog = setInterval(() => {
    if (!running) {
      return;
    }

    const registry = readRegistry();

    if (registry.activePid === myPid) {
      updateRegistry((reg) => {
        const self = reg.instances[String(myPid)];
        if (self) {
          self.heartbeat = Date.now();
        }
      });
      // The leader still consumes its inbox before the failover checks.
      consumeInbox();
      return;
    }

    const previousPid = registry.activePid;

    if (
      previousPid !== null &&
      previousPid !== myPid &&
      isPidAlive(previousPid) &&
      Date.now() - leaderHeartbeat(registry, previousPid) < LEADER_STALE_MS
    ) {
      consumeInbox();
      return;
    }

    const claimed = updateRegistry((reg) => {
      pruneDeadInstances(reg);
      const current = reg.activePid;
      if (
        current !== null &&
        current !== myPid &&
        isPidAlive(current) &&
        Date.now() - leaderHeartbeat(reg, current) < LEADER_STALE_MS
      ) {
        return;
      }
      reg.activePid = myPid;
    });

    if (claimed.activePid !== myPid) {
      consumeInbox();
      return;
    }

    adoptOffset();
    consumeInbox();

    const previousName =
      previousPid !== null && previousPid !== myPid
        ? registry.instances[String(previousPid)]?.name
        : undefined;
    const chatId = claimed.lastChatId;

    if (chatId !== null && previousName) {
      void sendMessage(
        chatId,
        `ℹ️ Instance "${previousName}" closed — this instance ("${myName}") took over Telegram control.`,
      );
    }
  }, 3000);

  // Drain this instance's registry inbox: /stop relays and ask taps that
  // arrived while another instance polled Telegram.
  async function consumeInbox(): Promise<void> {
    const inbox = readRegistry().instances[String(myPid)]?.inbox;
    if (!inbox) {
      return;
    }

    // Clear first: a slow handler must not re-run the same command.
    updateRegistry((reg) => {
      const self = reg.instances[String(myPid)];
      if (self) {
        self.inbox = null;
      }
    });

    if (inbox.kind === "stop") {
      console.log("[telegram] Inbox: stop relayed from Telegram");
      await stopLocalTask(null);
      return;
    }

    if (inbox.kind === "ask_dismiss") {
      console.log("[telegram] Inbox: ask dismiss relayed from Telegram");
      for (const toolCallId of [...askPolls.keys()]) {
        await closeAskPoll(
          toolCallId,
          "_Closed from Telegram — the answer was given in the terminal._",
        );
      }
      return;
    }

    // ask_answer: apply the tapped option to the matching local poll.
    const { questionId, optionIndex } = inbox;
    for (const [toolCallId, poll] of askPolls) {
      const question = poll.questions.find((q) => q.id === questionId);
      const option = question?.options[optionIndex];
      if (!question || !option) {
        continue;
      }

      console.log("[telegram] Inbox: ask answer relayed from Telegram");
      await closeAskPoll(
        toolCallId,
        `✅ **You answered from Telegram:** ${option.label}`,
      );

      try {
        await pi.sendUserMessage(
          `Answer to question "${question.question}": ${option.label}`,
        );
      } catch (error) {
        console.error("[telegram] Failed to deliver relayed answer:", error);
      }
      return;
    }
  }

  void poll();

  pi.on("session_shutdown", async () => {
    running = false;
    clearInterval(watchdog);
    // Deliberately leave both the instance entry and activePid in place: a
    // standby's watchdog sees the dead pid exactly like a crash, prunes it,
    // claims the poller role and sends the failover message (it reads the
    // instance name from its pre-prune registry snapshot). Startup prunes
    // stale entries, so nothing lingers.
    console.log("[telegram] Polling stopped");
  });
}
