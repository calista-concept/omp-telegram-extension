import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { FAKE_ENV, Harness, settle } from "./harness";

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(() => {
  h.dispose();
});
const privateWords = "PRIVATE source prompt answer cwd files research";
const commands = [
  "/start",
  "/stop",
  "/sessions",
  "/instances",
  "/asks",
  "/new",
  "/resume 1",
  "/use 1",
  "remote prompt",
];
function callbackData(): string {
  const message = [...h.sent()].reverse().find((message) => message.reply_markup);
  expect(message).toBeDefined();
  const markup = message!.reply_markup as { inline_keyboard: { callback_data: string }[][] };
  return markup.inline_keyboard[0][0].callback_data;
}
async function ask(bridge: ReturnType<Harness["bridge"]>): Promise<string> {
  await bridge.emit("tool_execution_start", {
    toolName: "ask",
    toolCallId: "ask-1",
    args: { questions: [{ id: "q1", question: privateWords, options: [{ label: "Answer A" }] }] },
  });
  return callbackData();
}

describe("local grants and native identity", () => {
  test("default OFF and notification opt-in never grants implicit control", async () => {
    const bridge = h.bridge(h.session("A"));
    await bridge.start();
    expect(h.calls).toHaveLength(0);
    expect(h.timers.size).toBe(0);
    await bridge.emit("before_agent_start", { prompt: privateWords });
    await bridge.emit("agent_end", { messages: [{ role: "assistant", content: privateWords }] });
    expect(h.calls).toHaveLength(0);
    await bridge.command("status");
    await bridge.command("");
    for (const command of commands) await h.deliver(command);
    expect(bridge.prompts).toHaveLength(0);
    expect(bridge.aborts).toBe(0);
    expect(bridge.newCount).toBe(0);
  });
  test("A/B in same process and cwd never share authorization; resume restores only A", async () => {
    const a = h.session("A"),
      b = h.session("B");
    const bridge = h.bridge(a);
    await bridge.start();
    await bridge.command("on");
    await bridge.command("control on");
    await bridge.switch(b);
    await bridge.command("status");
    expect(bridge.notices.at(-1)).toBe("Telegram OFF; control OFF.");
    const count = h.calls.length;
    await bridge.emit("before_agent_start", { prompt: privateWords });
    expect(h.calls).toHaveLength(count);
    await bridge.switch(a);
    await bridge.command("status");
    expect(bridge.notices.at(-1)).toBe("Telegram ON; control ON.");
    await bridge.command("off");
    await bridge.switch(b);
    await bridge.switch(a);
    await bridge.command("status");
    expect(bridge.notices.at(-1)).toBe("Telegram OFF; control OFF.");
  });
  test("same native session survives restart and title/path rename, never deletion/recreation", async () => {
    const session = h.session("A");
    const first = h.bridge(session);
    await first.start();
    await first.command("on");
    await first.shutdown();
    const resumed = h.bridge(session, 101);
    await resumed.start();
    await resumed.command("status");
    expect(resumed.notices.at(-1)).toBe("Telegram ON; control OFF.");
    const moved = { ...session, file: path.join(h.sessions, "renamed.jsonl") };
    renameSync(session.file, moved.file);
    resumed.session = moved;
    await h.tick();
    await resumed.command("status");
    expect(resumed.notices.at(-1)).toBe("Telegram ON; control OFF.");
    const bytes = readFileSync(moved.file, "utf8");
    renameSync(moved.file, `${moved.file}.deleted`);
    writeFileSync(moved.file, bytes, { mode: 0o600 });
    await h.tick();
    await resumed.command("status");
    expect(resumed.notices.at(-1)).toBe("Telegram OFF; control OFF.");
    expect(Object.keys(h.registry().grants)).toHaveLength(0);
  });
  test("fork/new events are OFF even with copied native entries and same cwd", async () => {
    const bridge = h.bridge(h.session("A"));
    await bridge.start();
    await bridge.command("on");
    await bridge.command("control on");
    await bridge.switch(h.session("fork"), "fork");
    await bridge.command("status");
    expect(bridge.notices.at(-1)).toContain("Telegram OFF");
    await bridge.command("on");
    await bridge.emit("session_branch", { reason: "fork" });
    await bridge.command("status");
    expect(bridge.notices.at(-1)).toContain("Telegram OFF");
    await bridge.switch(h.session("new"), "new");
    await bridge.command("status");
    expect(bridge.notices.at(-1)).toContain("Telegram OFF");
  });
  test("unsaved ID-bound grants promote only same live session; no unsaved restart recovery", async () => {
    const session = h.session("unsaved", false);
    const bridge = h.bridge(session);
    await bridge.start();
    await bridge.command("on");
    expect(bridge.anchors).toHaveLength(1);
    expect(existsSync(session.file)).toBe(false);
    await bridge.command("status");
    expect(bridge.notices.at(-1)).toBe("Telegram ON; control OFF.");
    await bridge.emit("before_agent_start", { prompt: privateWords });
    h.materialize(session);
    await bridge.emit("agent_end", { messages: [{ role: "assistant", content: privateWords }] });
    expect(h.sent().at(-1)?.text).toBe("OMP authorized session finished.");
    expect(Object.values(h.registry().grants)[0].pending).toBeUndefined();
    await bridge.shutdown();
    const restarted = h.bridge(session, 101);
    await restarted.start();
    await restarted.command("status");
    expect(restarted.notices.at(-1)).toContain("Telegram ON");
    const unsaved = h.bridge(h.session("never-saved", false), 102);
    await unsaved.start();
    await unsaved.command("on");
    await unsaved.shutdown();
    const restartUnsaved = h.bridge(unsaved.session, 103);
    await restartUnsaved.start();
    await restartUnsaved.command("status");
    expect(restartUnsaved.notices.at(-1)).toContain("Telegram OFF");
  });
  test("unsaved permission does not transfer to another native ID in same process", async () => {
    const bridge = h.bridge(h.session("draft-A", false));
    await bridge.start();
    await bridge.command("on");
    await bridge.switch(h.session("draft-B", false), "new");
    await bridge.command("status");
    expect(bridge.notices.at(-1)).toContain("Telegram OFF");
  });
  test("on/control are separate and on explicitly resets control", async () => {
    const bridge = h.bridge(h.session("A"));
    await bridge.start();
    await bridge.command("control on");
    expect(bridge.notices.at(-1)).toContain("Enable this session");
    await bridge.command("on");
    await bridge.command("control on");
    await h.deliver("authorized prompt");
    expect(bridge.prompts).toEqual(["authorized prompt"]);
    await bridge.command("on");
    await h.deliver("blocked prompt");
    expect(bridge.prompts).toEqual(["authorized prompt"]);
    await bridge.command("control on");
    await bridge.command("control off");
    await h.deliver("blocked again");
    expect(bridge.prompts).toEqual(["authorized prompt"]);
  });
});

describe("configuration, payload privacy and commands", () => {
  const invalidEnvironments: Record<string, string | undefined>[] = [
    {},
    { OMP_TELEGRAM_BOT_TOKEN: FAKE_ENV.OMP_TELEGRAM_BOT_TOKEN },
    { ...FAKE_ENV, OMP_TELEGRAM_USER_ID: "0" },
    { ...FAKE_ENV, OMP_TELEGRAM_USER_ID: "-1" },
    { ...FAKE_ENV, OMP_TELEGRAM_USER_ID: "777suffix" },
    { ...FAKE_ENV, OMP_TELEGRAM_USER_ID: "9007199254740993" },
    { ...FAKE_ENV, OMP_TELEGRAM_BOT_TOKEN: "invalid" },
  ];
  test.each(invalidEnvironments)(
    "missing/invalid explicit configuration is zero-network zero-timer zero-registry: %j",
    async (env) => {
      const bridge = h.bridge(h.session("A"), 100, env);
      await bridge.start();
      for (const command of ["status", "on", "test", "control on", "off"])
        await bridge.command(command);
      await bridge.emit("before_agent_start", { prompt: privateWords });
      await bridge.emit("agent_end", { messages: [{ role: "assistant", content: privateWords }] });
      expect(h.calls).toHaveLength(0);
      expect(h.timers.size).toBe(0);
      expect(existsSync(h.directory)).toBe(false);
      expect(bridge.notices.join(" ")).not.toContain(FAKE_ENV.OMP_TELEGRAM_BOT_TOKEN);
    },
  );
  test("notification-only events and test messages never include private content or metadata", async () => {
    const bridge = h.bridge(h.session("A"));
    await bridge.start();
    await bridge.command("on");
    await bridge.emit("before_agent_start", { prompt: privateWords });
    await bridge.emit("tool_result", { toolName: "todo", details: { phases: [privateWords] } });
    await bridge.emit("tool_execution_start", {
      toolName: "ask",
      toolCallId: "x",
      args: { questions: [{ question: privateWords, options: [{ label: privateWords }] }] },
    });
    await bridge.emit("agent_end", { messages: [{ role: "assistant", content: privateWords }] });
    await bridge.command("test");
    await h.deliver("/status");
    const payload = JSON.stringify(h.sent());
    for (const word of [privateWords, "/private/research", "/same/cwd", h.sessions])
      expect(payload).not.toContain(word);
    expect(payload).toContain("No session content included");
    expect(payload).toContain("remote control is off");
    const reg = readFileSync(h.registryFile(), "utf8");
    expect(reg).not.toContain(privateWords);
    expect(reg).not.toContain(FAKE_ENV.OMP_TELEGRAM_BOT_TOKEN);
    expect(lstatSync(h.registryFile()).mode & 0o777).toBe(0o600);
    expect(lstatSync(path.dirname(h.registryFile())).mode & 0o777).toBe(0o700);
  });
  test("control ON never exports prompt, answer, source, credentials, tool arguments or native ask labels", async () => {
    const bridge = h.bridge(h.session("A"));
    await bridge.start();
    await bridge.command("on");
    await bridge.command("control on");
    const prompt = "PROMPT_SENTINEL_PRIVATE";
    const answer = "ANSWER_SENTINEL_PRIVATE";
    const source = "CODE_SENTINEL_PRIVATE: console.log('not for Telegram')";
    const credential = "CREDENTIAL_SENTINEL_FAKE_NOT_A_SECRET";
    const toolArguments = "TOOL_ARGS_SENTINEL_PRIVATE";
    const question = `Question ${prompt} ${source}`;
    await bridge.emit("before_agent_start", { prompt: `${prompt} ${credential}` });
    await bridge.emit("tool_result", {
      toolName: "todo",
      details: { phases: [{ tasks: [{ content: toolArguments, blocker: source }] }] },
    });
    await bridge.emit("tool_execution_start", {
      toolName: "bash",
      toolCallId: "bash-private",
      args: { command: source, credential },
    });
    await bridge.emit("tool_execution_start", {
      toolName: "ask",
      toolCallId: "ask-private",
      args: {
        questions: [
          {
            question,
            options: [
              { label: toolArguments, description: credential },
              { label: credential, description: source },
            ],
          },
        ],
      },
    });
    const waiting = h.sent().at(-1)!;
    expect(waiting.text).toBe(
      "OMP is waiting for input. Review the question and choices in the local terminal. A Telegram choice queues a follow-up prompt; it does not resolve the native ask dialog.",
    );
    const markup = waiting.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    expect(markup.inline_keyboard.map((row) => row[0].text)).toEqual(["Choice 1", "Choice 2"]);
    h.callback(markup.inline_keyboard[0][0].callback_data);
    await h.tick();
    await h.tick();
    expect(bridge.prompts).toEqual([`Answer to question "${question}": ${toolArguments}`]);
    await bridge.emit("tool_execution_end", { toolName: "ask", toolCallId: "ask-private" });
    await bridge.emit("agent_end", {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: `${answer} ${source} ${credential}` }],
        },
      ],
    });
    expect(h.sent().at(-1)?.text).toBe("OMP authorized session finished.");
    await bridge.command("test");
    await h.deliver("/status");
    const payload = JSON.stringify(h.calls.map((call) => call.body));
    for (const sentinel of [
      prompt,
      answer,
      source,
      credential,
      toolArguments,
      "/private/research",
      "/same/cwd",
      h.sessions,
    ])
      expect(payload).not.toContain(sentinel);
    expect(payload).toContain("OMP authorized session is working.");
    expect(payload).toContain("No session content included.");
  });
  test("every unauthorized remote command, sender and group chat has no effect", async () => {
    const bridge = h.bridge(h.session("A"));
    await bridge.start();
    await bridge.command("on");
    for (const command of commands) await h.deliver(command);
    await bridge.command("control on");
    for (const command of [...commands, "/status"]) {
      await h.deliver(command, 888);
      await h.deliver(command, 777, -999);
    }
    expect(bridge.prompts).toHaveLength(0);
    expect(bridge.aborts).toBe(0);
    expect(bridge.newCount).toBe(0);
    expect(bridge.switches).toHaveLength(0);
    expect(JSON.stringify(h.sent())).not.toContain(h.sessions);
  });
  test("lists expose only authorized opaque IDs, never private sessions or cwd", async () => {
    const bridge = h.bridge(h.session("A"));
    h.session("private-secret-title");
    await bridge.start();
    await bridge.command("on");
    await bridge.command("control on");
    await h.deliver("/sessions");
    await h.deliver("/instances");
    const texts = h
      .sent()
      .map((message) => message.text)
      .join("\n");
    expect(texts).toContain("Authorized session");
    expect(texts).toContain("Authorized instance");
    expect(texts).not.toContain("private-secret-title");
    expect(texts).not.toContain("/private/research");
    expect(texts).not.toContain(h.sessions);
  });
  test("remote resume requires authorized target; remote new is OFF", async () => {
    const a = h.session("A"),
      b = h.session("B"),
      privateSession = h.session("private");
    const bridge = h.bridge(a);
    await bridge.start();
    await bridge.command("on");
    await bridge.command("control on");
    const aKey = Object.keys(h.registry().grants)[0];
    await bridge.switch(b);
    await bridge.command("on");
    await bridge.switch(a);
    await bridge.command("status"); // Re-capture command context only through an authorized local control command.
    await bridge.command("control on");
    const bKey = Object.keys(h.registry().grants).find((key) => key !== aKey)!;
    await h.deliver(`/resume ${bKey}`);
    await h.deliver(`/resume ${privateSession.file}`);
    expect(bridge.switches).toHaveLength(0);
    await bridge.switch(b);
    await bridge.command("control on");
    await bridge.switch(a);
    await bridge.command("control on");
    await h.deliver(`/resume ${bKey}`);
    expect(bridge.session.id).toBe("B");
    await bridge.command("control on");
    await h.deliver("/new");
    expect(bridge.newCount).toBe(1);
    await bridge.command("status");
    expect(bridge.notices.at(-1)).toBe("Telegram OFF; control OFF.");
    await h.deliver("new session prompt");
    expect(bridge.prompts).toHaveLength(0);
  });
});

describe("callbacks, inbox and revocation fences", () => {
  test("ask choices route only to exact authorized session, stale/forged callbacks are inert", async () => {
    const bridge = h.bridge(h.session("A"));
    await bridge.start();
    await bridge.command("on");
    await bridge.command("control on");
    const token = await ask(bridge);
    const forged = token.slice(0, -1) + (token.endsWith("f") ? "e" : "f");
    h.callback(token, 888);
    h.callback("ask:q1:0");
    h.callback(forged);
    await h.tick();
    await h.tick();
    expect(bridge.prompts).toHaveLength(0);
    h.callback(token);
    await h.tick();
    await h.tick();
    expect(bridge.prompts).toEqual([`Answer to question "${privateWords}": Answer A`]);
    h.callback(token);
    await h.tick();
    await h.tick();
    expect(bridge.prompts).toHaveLength(1);
    const second = await ask(bridge);
    await bridge.command("control off");
    h.callback(second);
    await h.tick();
    await h.tick();
    expect(bridge.prompts).toHaveLength(1);
  });
  test("revocation aborts a pending generic completion request and suppresses subsequent notifications", async () => {
    const bridge = h.bridge(h.session("A"));
    await bridge.start();
    await bridge.command("on");
    await bridge.command("control on");
    await bridge.emit("before_agent_start", { prompt: privateWords });
    const { promise, resolve: release } = Promise.withResolvers<Response>();
    const { promise: entered, resolve: markEntered } = Promise.withResolvers<AbortSignal>();
    h.hook = (call) => {
      if (call.method !== "sendMessage") return;
      markEntered(call.signal);
      return promise;
    };
    const finishing = bridge.emit("agent_end", {
      messages: [{ role: "assistant", content: "secret".repeat(2000) }],
    });
    const signal = await entered;
    expect(signal.aborted).toBe(false);
    expect(h.sent().at(-1)?.text).toBe("OMP authorized session finished.");
    const count = h.sent().length;
    await bridge.command("off");
    expect(signal.aborted).toBe(true);
    release(h.response({ message_id: 1 }));
    await finishing;
    expect(h.sent()).toHaveLength(count);
    await bridge.emit("before_agent_start", { prompt: privateWords });
    await bridge.emit("agent_end", { messages: [{ role: "assistant", content: privateWords }] });
    expect(h.sent()).toHaveLength(count);
    expect(Object.keys(h.registry().grants)).toHaveLength(0);
  });
  test("late long-poll results after session switch cannot deliver prompts or callbacks", async () => {
    const bridge = h.bridge(h.session("A"));
    await bridge.start();
    await bridge.command("on");
    await bridge.command("control on");
    const { promise, resolve: release } = Promise.withResolvers<Response>();
    h.hook = (call) => (call.method === "getUpdates" ? promise : undefined);
    await h.tick();
    const pending = h.calls.at(-1)!;
    h.message("stale prompt");
    await bridge.switch(h.session("B"), "new");
    expect(pending.signal.aborted).toBe(true);
    release(h.response(h.updates.splice(0)));
    await settle();
    await h.tick();
    expect(bridge.prompts).toHaveLength(0);
  });
  test("inbox revocation, mismatched instance/session, stale generation and expired envelopes fail closed", async () => {
    const bridge = h.bridge(h.session("A"));
    await bridge.start();
    await bridge.command("on");
    await bridge.command("control on");
    const ref = h.registry().controller!;
    const envelope = {
      source: ref,
      target: ref,
      action: { kind: "text" as const, text: "forged prompt" },
      expires: h.clock + 10000,
    };
    h.mutate((reg) => {
      reg.instances[ref.instance].inbox.push({ ...envelope, target: { ...ref, epoch: "stale" } });
      reg.instances[ref.instance].inbox.push({ ...envelope, expires: h.clock - 1 });
    });
    await h.tick();
    expect(bridge.prompts).toHaveLength(0);
    h.mutate((reg) => {
      reg.instances[ref.instance].inbox.push(envelope);
    });
    await bridge.command("control off");
    await h.tick();
    expect(bridge.prompts).toHaveLength(0);
    await bridge.command("control on");
    h.mutate((reg) => {
      reg.instances[ref.instance].inbox.push(envelope);
    });
    await h.tick();
    expect(bridge.prompts).toHaveLength(0);
  });
  test("local permission changes win over already queued authorized remote work", async () => {
    const bridge = h.bridge(h.session("A"));
    await bridge.start();
    await bridge.command("on");
    await bridge.command("control on");
    for (const operation of ["off", "control off", "on"]) {
      const ref = h.registry().controller!;
      h.mutate((reg) => {
        reg.instances[ref.instance].inbox.push({
          source: ref,
          target: ref,
          action: { kind: "text", text: `queued before ${operation}` },
          expires: h.clock + 10000,
        });
      });
      await bridge.command(operation);
      await h.tick();
      expect(bridge.prompts).toHaveLength(0);
      if (operation === "off") await bridge.command("on");
      await bridge.command("control on");
    }
  });
  test("control revocation during callback acknowledgment prevents queued answer", async () => {
    const bridge = h.bridge(h.session("A"));
    await bridge.start();
    await bridge.command("on");
    await bridge.command("control on");
    const token = await ask(bridge);
    const { promise, resolve: release } = Promise.withResolvers<Response>();
    h.hook = (call) => (call.method === "answerCallbackQuery" ? promise : undefined);
    h.callback(token);
    await h.tick();
    await h.tick();
    expect(h.calls.at(-1)?.method).toBe("answerCallbackQuery");
    await bridge.command("control off");
    release(h.response());
    await settle();
    expect(bridge.prompts).toHaveLength(0);
  });
  test("revocation before native transition acceptance cancels delayed new and resume", async () => {
    const a = h.bridge(h.session("A"), 100),
      b = h.bridge(h.session("B"), 101);
    await a.start();
    await b.start();
    await a.command("on");
    await a.command("control on");
    await b.command("on");
    await b.command("control on");
    const { promise: newGate, resolve: releaseNew } = Promise.withResolvers<void>();
    a.beforeTransition = () => newGate;
    await h.deliver("/new");
    expect(a.newCount).toBe(0);
    await a.command("off");
    releaseNew();
    await settle();
    expect(a.newCount).toBe(0);
    await a.command("on");
    await a.command("control on");
    const aRef = Object.values(h.registry().instances).find((entry) => entry.pid === 100)!.ref;
    await h.deliver(`/use ${aRef.instance}`);
    const { promise: resumeGate, resolve: releaseResume } = Promise.withResolvers<void>();
    a.beforeTransition = () => resumeGate;
    const bKey = Object.values(h.registry().instances).find((entry) => entry.pid === 101)!.ref.key;
    await h.deliver(`/resume ${bKey}`);
    expect(a.switches).toHaveLength(0);
    await b.command("off");
    releaseResume();
    await settle();
    expect(a.switches).toHaveLength(0);
  });
});

describe("multi-instance coordination", () => {
  test("single poller, authorized standby routing, switch does not grant private target access", async () => {
    const a = h.bridge(h.session("A"), 100),
      b = h.bridge(h.session("B"), 101),
      privateBridge = h.bridge(h.session("private"), 102);
    await a.start();
    await b.start();
    await privateBridge.start();
    await a.command("on");
    await a.command("control on");
    await b.command("on");
    await b.command("control on");
    const registry = h.registry();
    expect(Object.keys(registry.instances)).toHaveLength(2);
    const bRef = Object.values(registry.instances).find((entry) => entry.pid === 101)!.ref;
    const polls = h.calls.filter((call) => call.method === "getUpdates").length;
    await h.tick();
    expect(h.calls.filter((call) => call.method === "getUpdates").length - polls).toBe(1);
    await h.deliver(`/use ${bRef.instance}`);
    await h.deliver("B prompt");
    expect(a.prompts).toHaveLength(0);
    expect(b.prompts).toEqual(["B prompt"]);
    await h.deliver("/use private");
    await h.deliver("still B");
    expect(privateBridge.prompts).toHaveLength(0);
    expect(b.prompts.at(-1)).toBe("still B");
    await b.command("off");
    await h.deliver("not B");
    expect(b.prompts).toHaveLength(2);
  });
  test("routing switch fences already queued work and stop affects only selected authorized target", async () => {
    const a = h.bridge(h.session("A"), 100),
      b = h.bridge(h.session("B"), 101);
    await a.start();
    await b.start();
    await a.command("on");
    await a.command("control on");
    await b.command("on");
    await b.command("control on");
    const bRef = Object.values(h.registry().instances).find((entry) => entry.pid === 101)!.ref;
    h.message(`/use ${bRef.instance}`);
    h.message("queued under old controller");
    await h.tick();
    await h.tick();
    expect(a.prompts).toHaveLength(0);
    expect(b.prompts).toHaveLength(0);
    await h.deliver("/stop");
    expect(a.aborts).toBe(0);
    expect(b.aborts).toBe(1);
    await h.deliver("new controller prompt");
    expect(b.prompts).toEqual(["new controller prompt"]);
  });
  test("cross-instance ask callback requires both authorized controller and authorized target", async () => {
    const a = h.bridge(h.session("A"), 100),
      b = h.bridge(h.session("B"), 101);
    await a.start();
    await b.start();
    await a.command("on");
    await a.command("control on");
    await b.command("on");
    await b.command("control on");
    const token = await ask(b);
    h.callback(token);
    await h.tick();
    await h.tick();
    expect(b.prompts).toHaveLength(1);
    expect(a.prompts).toHaveLength(0);
    const stale = await ask(b);
    await a.command("control off"); // Controller A revoked; B may become a new independent authorized controller only on its next publish.
    await b.command("control off");
    h.callback(stale);
    await h.tick();
    await h.tick();
    expect(b.prompts).toHaveLength(1);
  });
  test("dead leader failover adopts offset and never grants access to private session", async () => {
    const a = h.bridge(h.session("A"), 100),
      b = h.bridge(h.session("B"), 101);
    await a.start();
    await b.start();
    await a.command("on");
    await a.command("control on");
    await b.command("on");
    await b.command("control on");
    await h.deliver("before failover");
    const offset = h.registry().offset;
    const previousLeader = h.registry().leader;
    h.live.delete(100);
    for (const [id, timer] of h.timers) if (timer.pid === 100) h.timers.delete(id);
    h.clock += 31_000;
    await h.tick();
    await h.tick();
    expect(h.registry().leader).not.toBe(previousLeader);
    expect(h.registry().offset).toBeGreaterThanOrEqual(offset);
    await h.deliver("after failover");
    expect(b.prompts).toEqual(["after failover"]);
    expect(Object.values(h.registry().instances).every((entry) => entry.pid !== 100)).toBe(true);
  });
  test("race-safe stale lock recovery and live-lock contention fail closed", async () => {
    const bridge = h.bridge(h.session("A"));
    await bridge.start();
    const lock = path.join(path.dirname(h.registryFile()), "registry.lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(path.join(lock, "999-dead-beef"), "", { mode: 0o600 });
    await bridge.command("on");
    expect(bridge.notices.at(-1)).toBe("Telegram ON; control OFF.");
    mkdirSync(lock, { mode: 0o700 });
    const owner = path.join(lock, "100-abcd-dead");
    writeFileSync(owner, "", { mode: 0o600 });
    const before = h.calls.length;
    await bridge.command("off");
    expect(h.calls).toHaveLength(before);
    expect(bridge.notices.at(-1)).toContain("unavailable");
    const restarted = h.bridge(bridge.session, 101);
    await restarted.start();
    await restarted.command("status");
    expect(restarted.notices.at(-1)).toBe("Telegram OFF; control OFF.");
    unlinkSync(owner); // An ownerless lock must remain fail-closed rather than racing a live creator.
    await bridge.command("on");
    expect(bridge.notices.at(-1)).toContain("unavailable");
  });
  test("first activation drops old Telegram backlog; shared offset survives clean leadership transfer", async () => {
    h.message("old backlog");
    const a = h.bridge(h.session("A"));
    await a.start();
    await a.command("on");
    await a.command("control on");
    expect(a.prompts).toHaveLength(0);
    expect(h.registry().initialized).toBe(true);
    const offset = h.registry().offset;
    await a.shutdown();
    const b = h.bridge(a.session, 101);
    await b.start();
    await b.command("control on");
    await h.deliver("fresh prompt");
    expect(b.prompts).toEqual(["fresh prompt"]);
    expect(h.registry().offset).toBeGreaterThan(offset);
  });
});
