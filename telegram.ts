import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { clearInterval as clearNativeInterval, setInterval as nativeInterval } from "node:timers";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

const LEASE_MS = 30_000;
const TIMEOUT_MS = 35_000;
type Identity = { key: string; file: string; pending?: { owner: string; nativeId: string } };
type Grant = Identity & { revision: string; control: boolean };
type Ref = { instance: string; key: string; revision: string; epoch: string };
type Action =
  | { kind: "text"; text: string }
  | { kind: "callback"; token: string; callbackId: string };
type Envelope = { source: Ref; target: Ref; action: Action; expires: number };
type Instance = { pid: number; heartbeat: number; ref: Ref; inbox: Envelope[] };
type Registry = {
  version: 2;
  offset: number;
  initialized: boolean;
  leader: string | null;
  leaderEpoch: string;
  controller: Ref | null;
  instances: Record<string, Instance>;
  grants: Record<string, Grant>;
};
export type TelegramRegistry = Registry;
type Update = {
  update_id: number;
  message?: { from?: { id: number }; chat: { id: number; type?: string }; text?: string };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number; type?: string } };
    data?: string;
  };
};
type ApiResult = { ok?: boolean; result?: unknown };
type Fence = { ref: Ref; control: boolean; generation: number; source?: Ref };
type Ask = { fence: Fence; tool: string; question: string; option: string };

export type TelegramTimer = number | NodeJS.Timeout;

/** Dependency injection is only for isolated deterministic tests; production uses native APIs. */
export interface TelegramRuntime {
  env?: Record<string, string | undefined>;
  directory?: string;
  pid?: number;
  alive?: (pid: number) => boolean;
  now?: () => number;
  fetch?: typeof fetch;
  interval?: (callback: () => void, ms: number) => TelegramTimer;
  clearInterval?: (timer: TelegramTimer) => void;
}

function emptyRegistry(): Registry {
  return {
    version: 2,
    offset: 0,
    initialized: false,
    leader: null,
    leaderEpoch: randomUUID(),
    controller: null,
    instances: {},
    grants: {},
  };
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
function same(a: Ref | null | undefined, b: Ref | null | undefined): boolean {
  return (
    !!a &&
    !!b &&
    a.instance === b.instance &&
    a.key === b.key &&
    a.revision === b.revision &&
    a.epoch === b.epoch
  );
}

// Read only the header of an explicitly known session, never scan session directories.
// The file incarnation prevents a deleted/recreated transcript from inheriting a grant.
function identity(file: string | undefined, expectedId?: string): Identity | null {
  if (!file) return null;
  let fd: number | undefined;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(16_384);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const header = JSON.parse(buffer.toString("utf8", 0, size).split("\n", 1)[0]);
    if (
      header.type !== "session" ||
      typeof header.id !== "string" ||
      !header.id ||
      typeof header.timestamp !== "string"
    )
      return null;
    if (expectedId !== undefined && expectedId !== header.id) return null;
    return {
      key: hash(
        JSON.stringify([header.id, header.timestamp, stat.dev, stat.ino, stat.birthtimeMs]),
      ),
      file: path.resolve(file),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Synchronous, short transactions with an exclusive directory lock. Stale-lock
// recovery elects exactly one reaper by unlinking the unique owner's filename.
// An ownerless lock is deliberately fail-closed (manual local recovery only).
class Store {
  readonly file: string;
  readonly lock: string;
  constructor(
    readonly directory: string,
    readonly pid: number,
    readonly isAlive: (pid: number) => boolean,
  ) {
    this.file = path.join(directory, "registry.json");
    this.lock = path.join(directory, "registry.lock");
  }
  private directoryReady(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
      throw new Error("Unsafe registry directory");
    chmodSync(this.directory, 0o700);
  }
  revoked(key: string, revision: string): boolean {
    try {
      lstatSync(path.join(this.directory, `${key}.${revision}.revoked`));
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }
  revoke(key: string, revision: string): void {
    this.directoryReady();
    try {
      writeFileSync(path.join(this.directory, `${key}.${revision}.revoked`), "", {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  read(): Registry {
    try {
      const stat = lstatSync(this.file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077
      )
        throw new Error("Unsafe registry");
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Registry;
      if (data.version !== 2 || !data.grants || !data.instances)
        throw new Error("Invalid registry");
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
      throw new Error("Telegram local registry unavailable");
    }
  }
  change<T>(mutate: (registry: Registry) => T): T {
    this.directoryReady();
    const owner = `${this.pid}-${randomUUID()}`;
    try {
      mkdirSync(this.lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owners = readdirSync(this.lock);
      if (
        owners.length !== 1 ||
        !/^\d+-[\da-f-]+$/.test(owners[0]) ||
        this.isAlive(Number(owners[0].split("-", 1)[0]))
      )
        throw new Error("Telegram registry busy");
      // Only the process that successfully removes this exact owner may rmdir.
      unlinkSync(path.join(this.lock, owners[0]));
      rmdirSync(this.lock);
      mkdirSync(this.lock, { mode: 0o700 });
    }
    const ownerFile = path.join(this.lock, owner);
    let tmp: string | undefined;
    try {
      writeFileSync(ownerFile, "", { flag: "wx", mode: 0o600 });
      const registry = this.read();
      const result = mutate(registry);
      tmp = `${this.file}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(registry), { flag: "wx", mode: 0o600 });
      renameSync(tmp, this.file);
      tmp = undefined;
      return result;
    } finally {
      if (tmp) {
        try {
          unlinkSync(tmp);
        } catch {}
      }
      unlinkSync(ownerFile);
      rmdirSync(this.lock);
    }
  }
}

export function createTelegramExtension(pi: ExtensionAPI, runtime: TelegramRuntime = {}): void {
  const env = runtime.env ?? process.env;
  const token = env.OMP_TELEGRAM_BOT_TOKEN ?? "";
  const userText = env.OMP_TELEGRAM_USER_ID ?? "";
  const user = Number(userText);
  const configured =
    /^\d+:[A-Za-z0-9_-]{30,}$/.test(token) &&
    /^[1-9]\d*$/.test(userText) &&
    Number.isSafeInteger(user);
  const now = runtime.now ?? Date.now;
  const isAlive = runtime.alive ?? alive;
  const pid = runtime.pid ?? process.pid;
  const request = runtime.fetch ?? globalThis.fetch;
  const every = runtime.interval ?? nativeInterval;
  const clear = runtime.clearInterval ?? clearNativeInterval;
  // Separate namespaces for bot/account pairs; neither credential is persisted.
  const directory = path.join(
    runtime.directory ?? path.join(os.homedir(), ".omp", "telegram-private"),
    hash(`${token}\0${userText}`).slice(0, 24),
  );
  const store = new Store(directory, pid, isAlive);
  const instance = randomUUID();
  let context: ExtensionContext | null = null;
  let commandContext: ExtensionCommandContext | null = null;
  let current: Identity | null = null;
  let pending: Identity | null = null;
  let epoch = randomUUID();
  let generation = 0;
  let stopped = false;
  let timer: TelegramTimer | undefined;
  let ticking = false;
  let polling = false;
  let runningTask: { fence: Fence } | null = null;
  let transition: { fence: Fence; kind: "new" | "resume"; target?: Grant } | null = null;
  const requests = new Set<AbortController>();
  const asks = new Map<string, Ask>();
  const deniedKeys = new Set<string>();

  function invalidate(): void {
    generation++;
    epoch = randomUUID();
    for (const controller of requests) controller.abort();
    requests.clear();
    asks.clear();
    runningTask = null;
  }
  function localIdentity(ctx: ExtensionContext | null = context): Identity | null {
    if (!ctx) return null;
    const nativeId = ctx.sessionManager.getSessionId();
    const physical = identity(ctx.sessionManager.getSessionFile(), nativeId);
    if (physical) return physical;
    const file = ctx.sessionManager.getSessionFile();
    if (!file || pending?.pending?.nativeId !== nativeId || pending.file !== path.resolve(file))
      return null;
    try {
      lstatSync(file);
      return null;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? pending : null;
    }
  }
  function grantValid(grant: Grant | undefined): grant is Grant {
    if (!grant || deniedKeys.has(grant.key) || store.revoked(grant.key, grant.revision))
      return false;
    if (grant.pending) {
      try {
        lstatSync(grant.file);
        return !!identity(grant.file, grant.pending.nativeId);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
      }
    }
    return identity(grant.file)?.key === grant.key;
  }
  function adoptIdentity(ctx: ExtensionContext): Identity | null {
    const next = localIdentity(ctx);
    if (
      pending &&
      next &&
      !next.pending &&
      pending.pending?.nativeId === ctx.sessionManager.getSessionId()
    ) {
      const previous = pending;
      try {
        store.change((reg) => {
          const grant = reg.grants[previous.key];
          if (grant?.pending?.owner === instance && grantValid(grant)) {
            reg.grants[next.key] = { ...next, revision: grant.revision, control: grant.control };
            delete reg.grants[previous.key];
            const entry = reg.instances[instance];
            if (entry) {
              entry.ref.key = next.key;
              entry.inbox = [];
            }
            if (reg.controller?.instance === instance) reg.controller.key = next.key;
          }
        });
      } catch {
        // Failure to promote cannot interrupt an OMP turn or recover access.
        pending = null;
        return next;
      }
      for (const request of requests) request.abort();
      requests.clear();
      asks.clear();
      generation++;
      if (runningTask)
        runningTask.fence = {
          ...runningTask.fence,
          generation,
          ref: { ...runningTask.fence.ref, key: next.key },
        };
      current = next;
      pending = null;
    }
    return next;
  }
  function refValid(reg: Registry, ref: Ref | null | undefined, control: boolean): ref is Ref {
    if (!ref) return false;
    const entry = reg.instances[ref.instance];
    const grant = reg.grants[ref.key];
    return (
      !!entry &&
      same(entry.ref, ref) &&
      now() - entry.heartbeat < LEASE_MS &&
      isAlive(entry.pid) &&
      grantValid(grant) &&
      grant.revision === ref.revision &&
      (!control || grant.control)
    );
  }
  function snapshot(control = false, source?: Ref): Fence | null {
    if (!configured || stopped || !current || localIdentity()?.key !== current.key) return null;
    try {
      const reg = store.read();
      const entry = reg.instances[instance];
      if (
        !refValid(reg, entry?.ref, control) ||
        entry.ref.epoch !== epoch ||
        entry.ref.key !== current.key ||
        (source && (!refValid(reg, source, true) || !same(reg.controller, source)))
      )
        return null;
      return { ref: { ...entry.ref }, control, generation, source };
    } catch {
      return null;
    }
  }
  function valid(fence: Fence): boolean {
    if (
      stopped ||
      generation !== fence.generation ||
      epoch !== fence.ref.epoch ||
      localIdentity()?.key !== fence.ref.key
    )
      return false;
    try {
      const reg = store.read();
      return (
        refValid(reg, fence.ref, fence.control) &&
        (!fence.source || (refValid(reg, fence.source, true) && same(reg.controller, fence.source)))
      );
    } catch {
      return false;
    }
  }
  function prune(reg: Registry): void {
    // An active renamed session updates its known path before this prune.
    for (const [key, grant] of Object.entries(reg.grants))
      if (!grantValid(grant)) delete reg.grants[key];
    for (const [id, entry] of Object.entries(reg.instances)) {
      if (!isAlive(entry.pid) || now() - entry.heartbeat >= LEASE_MS || !reg.grants[entry.ref.key])
        delete reg.instances[id];
    }
    for (const [key, grant] of Object.entries(reg.grants)) {
      if (
        grant.pending &&
        !reg.instances[grant.pending.owner] &&
        !(grant.pending.owner === instance && current?.key === key)
      )
        delete reg.grants[key];
    }
    if (!refValid(reg, reg.controller, true)) reg.controller = null;
    if (!reg.leader || !reg.instances[reg.leader]) {
      reg.leader = null;
      reg.leaderEpoch = randomUUID();
    }
  }
  function publish(): void {
    if (!configured || stopped) return;
    store.change((reg) => {
      if (current && localIdentity()?.key === current.key && reg.grants[current.key])
        reg.grants[current.key].file = current.file;
      prune(reg);
      const grant = current && reg.grants[current.key];
      if (grant) {
        const previous = reg.instances[instance];
        const ref = { instance, key: grant.key, revision: grant.revision, epoch };
        reg.instances[instance] = {
          pid,
          heartbeat: now(),
          ref,
          inbox: same(previous?.ref, ref) ? previous.inbox : [],
        };
        if (!reg.controller && grant.control) reg.controller = ref;
        if (!reg.leader) {
          reg.leader = instance;
          reg.leaderEpoch = randomUUID();
        }
      } else {
        delete reg.instances[instance];
        if (reg.leader === instance) {
          reg.leader = null;
          reg.leaderEpoch = randomUUID();
        }
        if (reg.controller?.instance === instance) reg.controller = null;
      }
    });
  }
  function ensureTimer(): void {
    if (!configured || stopped || !current || !snapshot()) return;
    if (timer === undefined)
      timer = every(() => {
        void tick();
      }, 1000);
    void tick();
  }
  function stopTimer(): void {
    if (timer !== undefined) clear(timer);
    timer = undefined;
  }
  function bind(ctx: ExtensionContext, activate = true): void {
    context = ctx;
    const next = adoptIdentity(ctx);
    if (next?.key !== current?.key) {
      invalidate();
      commandContext = null;
    }
    current = next;
    if (configured) {
      try {
        publish();
        if (activate) ensureTimer();
      } catch {
        /* Fail closed; local status remains available. */
      }
      if (!snapshot()) stopTimer();
    }
  }

  async function api(
    method: string,
    body: Record<string, unknown>,
    fence: Fence,
    extra: () => boolean = () => true,
  ): Promise<ApiResult | null> {
    if (!valid(fence) || !extra()) return null;
    const controller = new AbortController();
    requests.add(controller);
    try {
      const response = await request(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
      if (!valid(fence) || !extra() || !response.ok) return null;
      const result = (await response.json()) as ApiResult;
      return valid(fence) && extra() && result.ok ? result : null;
    } catch {
      return null;
    } finally {
      // Never log a token-bearing URL, response, prompt, or exception.
      requests.delete(controller);
    }
  }
  async function send(text: string, fence: Fence, keyboard?: unknown): Promise<void> {
    for (let offset = 0; offset < text.length; offset += 3500) {
      if (!valid(fence)) return;
      await api(
        "sendMessage",
        {
          chat_id: user,
          text: text.slice(offset, offset + 3500),
          ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
        },
        fence,
      );
    }
  }
  function authorizedSessions(reg: Registry): Grant[] {
    return Object.values(reg.grants)
      .filter((grant) => grant.control && grantValid(grant))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
  function authorizedInstances(reg: Registry): Ref[] {
    return Object.values(reg.instances)
      .map((entry) => entry.ref)
      .filter((ref) => refValid(reg, ref, true))
      .sort((a, b) => a.instance.localeCompare(b.instance));
  }
  async function route(action: Action, target: Ref, source: Ref): Promise<void> {
    store.change((reg) => {
      if (!refValid(reg, source, true) || !refValid(reg, target, true)) return;
      const inbox = reg.instances[target.instance].inbox;
      if (inbox.length < 50) inbox.push({ source, target, action, expires: now() + LEASE_MS });
    });
  }
  async function execute(envelope: Envelope): Promise<void> {
    if (envelope.expires < now()) return;
    const fence = snapshot(true, envelope.source);
    if (!fence || !same(fence.ref, envelope.target) || !valid(fence)) return;
    if (envelope.action.kind === "callback") {
      const ask = asks.get(envelope.action.token);
      if (!ask || !same(ask.fence.ref, fence.ref) || !valid(ask.fence)) return;
      asks.delete(envelope.action.token);
      await api("answerCallbackQuery", { callback_query_id: envelope.action.callbackId }, fence);
      if (valid(fence))
        await pi.sendUserMessage(`Answer to question "${ask.question}": ${ask.option}`);
      return;
    }
    const text = envelope.action.text.trim();
    const [verb, argument] = text.split(/\s+/, 2);
    if (
      ["/stop", "/status", "/instances", "/sessions", "/use", "/resume", "/new", "/start"].includes(
        verb,
      )
    ) {
      if (verb === "/stop") {
        if (valid(fence)) context?.abort();
        return;
      }
      if (verb === "/status" || verb === "/start") {
        await send(
          context?.isIdle() ? "OMP authorized session: idle." : "OMP authorized session: working.",
          fence,
        );
        return;
      }
      if (verb === "/instances") {
        const refs = authorizedInstances(store.read());
        await send(
          refs.map((ref) => `Authorized instance ${ref.instance}`).join("\n") ||
            "No authorized instances.",
          fence,
        );
        return;
      }
      if (verb === "/sessions") {
        await send(
          authorizedSessions(store.read())
            .map((grant) => `Authorized session ${grant.key}`)
            .join("\n") || "No authorized sessions.",
          fence,
        );
        return;
      }
      if (verb === "/use") {
        store.change((reg) => {
          if (!valid(fence) || !refValid(reg, envelope.source, true)) return;
          const target = authorizedInstances(reg).find((ref) => ref.instance === argument);
          if (target) reg.controller = target; // Poller ownership is not an access grant.
        });
        await send("Authorized routing request processed.", fence);
        return;
      }
      if (!commandContext || !context?.isIdle()) {
        await send(
          "Run /telegram control on locally in this idle session before switching.",
          fence,
        );
        return;
      }
      if (verb === "/new") {
        transition = { fence, kind: "new" };
        try {
          if (valid(fence)) await commandContext.newSession();
        } finally {
          transition = null;
        }
        // No reply or inherited grant: the resulting session is OFF.
        return;
      }
      if (verb === "/resume") {
        const target = authorizedSessions(store.read()).find((grant) => grant.key === argument);
        if (!target || !valid(fence)) return;
        const check = store.read().grants[target.key];
        if (
          !check?.control ||
          check.revision !== target.revision ||
          !grantValid(check) ||
          !valid(fence)
        )
          return;
        transition = { fence, kind: "resume", target: check };
        try {
          if (valid(fence)) await commandContext.switchSession(check.file);
        } finally {
          transition = null;
        }
        return;
      }
    }
    // Unknown slash commands never become agent prompts.
    if (text.startsWith("/") || !valid(fence)) return;
    await pi.sendUserMessage(text);
  }
  async function consumeInbox(): Promise<void> {
    let inbox: Envelope[] = [];
    store.change((reg) => {
      const self = reg.instances[instance];
      if (self) {
        inbox = self.inbox;
        self.inbox = [];
      }
    });
    for (const envelope of inbox) {
      try {
        await execute(envelope);
      } catch {
        /* No raw errors or private payloads. */
      }
    }
  }
  async function receive(update: Update, pollFence: Fence, leaderEpoch: string): Promise<void> {
    if (!valid(pollFence)) return;
    const reg = store.read();
    if (reg.leader !== instance || reg.leaderEpoch !== leaderEpoch) return;
    const callback = update.callback_query;
    const sender = callback?.from.id ?? update.message?.from?.id;
    const chat = callback?.message?.chat ?? update.message?.chat;
    if (sender !== user || chat?.id !== user || (chat.type && chat.type !== "private")) return;
    const source = reg.controller;
    if (!refValid(reg, source, true)) {
      // Notification-only mode exposes only generic status, not instance/session metadata.
      if (!callback && update.message?.text?.trim() === "/status")
        await send("OMP Telegram notifications enabled; remote control is off.", pollFence);
      return;
    }
    if (callback) {
      const match = /^a:([\da-f-]{36}):([\da-f]{16})$/.exec(callback.data ?? "");
      if (!match) return;
      const target = reg.instances[match[1]]?.ref;
      if (!refValid(reg, target, true)) return;
      await route({ kind: "callback", token: match[2], callbackId: callback.id }, target, source);
      return;
    }
    if (typeof update.message?.text === "string")
      await route({ kind: "text", text: update.message.text }, source, source);
  }
  async function poll(): Promise<void> {
    if (polling) return;
    const fence = snapshot();
    if (!fence) return;
    const registry = store.read();
    if (registry.leader !== instance) return;
    const leaderEpoch = registry.leaderEpoch;
    const owns = () => {
      const reg = store.read();
      return reg.leader === instance && reg.leaderEpoch === leaderEpoch;
    };
    polling = true;
    try {
      const result = await api(
        "getUpdates",
        {
          offset: registry.initialized ? registry.offset : -1,
          timeout: 10,
          allowed_updates: ["message", "callback_query"],
        },
        fence,
        owns,
      );
      if (!result || !Array.isArray(result.result) || !valid(fence) || !owns()) return;
      const updates = result.result as Update[];
      for (const update of updates) {
        if (!Number.isSafeInteger(update.update_id) || !valid(fence) || !owns()) return;
        // First registration discards Telegram's old backlog; subsequent leaders share the cursor.
        if (registry.initialized) await receive(update, fence, leaderEpoch);
        if (!valid(fence) || !owns()) return;
        store.change((reg) => {
          if (reg.leader === instance && reg.leaderEpoch === leaderEpoch)
            reg.offset = Math.max(reg.offset, update.update_id + 1);
        });
      }
      if (valid(fence) && owns())
        store.change((reg) => {
          if (reg.leader === instance && reg.leaderEpoch === leaderEpoch) reg.initialized = true;
        });
    } finally {
      polling = false;
    }
  }
  async function tick(): Promise<void> {
    if (ticking || stopped || !configured) return;
    ticking = true;
    try {
      // Native rename/relocation retains the identity; deletion and replacement do not.
      const next = context ? adoptIdentity(context) : null;
      if (next?.key !== current?.key) {
        invalidate();
        commandContext = null;
      }
      current = next;
      publish();
      if (!snapshot()) {
        stopTimer();
        return;
      }
      await consumeInbox();
      if (snapshot()) void poll().catch(() => {});
    } catch {
      /* Contention and malformed local state fail closed. */
    } finally {
      ticking = false;
    }
  }

  async function localCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    // Reconcile identity without draining an inbox or starting a poll: local
    // permission changes must take precedence over already queued remote work.
    bind(ctx, false);
    const operation = args.trim().toLowerCase() || "on";
    const notify = (message: string) => ctx.ui.notify(message, "info");
    if (operation === "status") {
      const fence = snapshot();
      notify(
        !configured
          ? "Telegram unconfigured; OFF. Explicit bot token and positive numeric user ID are required in the environment."
          : `Telegram ${fence ? "ON" : "OFF"}; control ${snapshot(true) ? "ON" : "OFF"}.`,
      );
      return;
    }
    if (!["on", "off", "test", "control on", "control off"].includes(operation)) {
      notify("Usage: /telegram [on|off|status|test|control on|control off]");
      return;
    }
    if (!configured) {
      notify(
        "Telegram unconfigured; no network or poll timers started. Configure credentials outside OMP, then reload the extension.",
      );
      return;
    }
    if (operation === "test") {
      const fence = snapshot();
      if (!fence) {
        notify("Telegram OFF. Enable this session locally first.");
        return;
      }
      await send("OMP Telegram test notification. No session content included.", fence);
      notify(
        valid(fence)
          ? "Telegram test request completed (delivery is not guaranteed)."
          : "Telegram test cancelled; authorization changed.",
      );
      return;
    }
    if (!current && operation === "on") {
      const nativeId = ctx.sessionManager.getSessionId();
      const file = ctx.sessionManager.getSessionFile();
      if (nativeId && file) {
        const nonce = randomUUID();
        // Native custom entries record the anchor without a provider request;
        // OMP can defer disk materialization until its first assistant message.
        pi.appendEntry("telegram-session-anchor", { sessionId: nativeId, nonce });
        pending = {
          key: hash(`${instance}\0${nativeId}\0${nonce}`),
          file: path.resolve(file),
          pending: { owner: instance, nativeId },
        };
        current = localIdentity(ctx);
      }
    }
    if (!current) {
      notify("Telegram OFF: no native session identity is available.");
      return;
    }
    const old = snapshot();
    if (operation === "control on" && !old) {
      notify("Enable this session with /telegram on before enabling control.");
      return;
    }
    if (operation === "control off" && !old) {
      notify("Telegram OFF; control OFF.");
      return;
    }
    invalidate(); // Fence every pending request, callback and run before changing the grant.
    deniedKeys.add(current.key);
    try {
      // Independent tombstone makes OFF durable even if another process holds
      // the registry lock. A failed permission change can only remove access.
      const existing = store.read().grants[current.key];
      if (existing) store.revoke(current.key, existing.revision);
      store.change((reg) => {
        if (operation === "off") delete reg.grants[current!.key];
        else {
          const previous = reg.grants[current!.key];
          reg.grants[current!.key] = {
            ...current!,
            revision: randomUUID(),
            control: operation === "control on",
          };
          // Explicit /on resets control, including on an existing grant.
          if (!previous && operation === "control off") delete reg.grants[current!.key];
        }
        delete reg.instances[instance];
        if (reg.controller?.instance === instance) reg.controller = null;
        if (reg.leader === instance) {
          reg.leader = null;
          reg.leaderEpoch = randomUUID();
        }
      });
      if (operation !== "off") deniedKeys.delete(current.key);
      commandContext = ctx;
      publish();
      if (operation === "off") stopTimer();
      else ensureTimer();
      notify(`Telegram ${snapshot() ? "ON" : "OFF"}; control ${snapshot(true) ? "ON" : "OFF"}.`);
    } catch {
      stopTimer();
      notify("Telegram local registry unavailable; no new access granted. Retry locally.");
    }
  }
  pi.registerCommand("telegram", {
    description: "Session-scoped Telegram notifications and separate remote control",
    handler: localCommand,
  });
  pi.on("session_start", async (_event, ctx) => bind(ctx));
  pi.on("session_before_switch", async (event) => {
    const pending = transition;
    if (!pending || pending.kind !== event.reason) return;
    if (pending.target && path.resolve(event.targetSessionFile ?? "") !== pending.target.file)
      return;
    if (!valid(pending.fence)) return { cancel: true };
    if (pending.target) {
      try {
        const grant = store.read().grants[pending.target.key];
        if (!grant?.control || grant.revision !== pending.target.revision || !grantValid(grant))
          return { cancel: true };
      } catch {
        return { cancel: true };
      }
    }
  });
  function denyIdentity(next: Identity | null): void {
    if (!configured || !next) return;
    deniedKeys.add(next.key);
    try {
      const existing = store.read().grants[next.key];
      if (existing) store.revoke(next.key, existing.revision);
    } catch {
      /* The in-memory deny remains effective if local storage fails. */
    }
  }
  pi.on("session_switch", async (event, ctx) => {
    invalidate();
    commandContext = null;
    if (event.reason === "new" || event.reason === "fork") denyIdentity(localIdentity(ctx));
    bind(ctx);
    if (!snapshot()) stopTimer();
  });
  pi.on("session_branch", async (_event, ctx) => {
    invalidate();
    commandContext = null;
    denyIdentity(localIdentity(ctx));
    bind(ctx);
    stopTimer();
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    bind(ctx);
    const fence = snapshot();
    if (!fence) return;
    runningTask = { fence };
    // Generic status only, even when the prompt contains secrets or source.
    void send("OMP authorized session is working.", fence);
  });
  pi.on("agent_end", async (event, ctx) => {
    bind(ctx);
    if (event.willContinue || event.awaitingAsyncWork) return;
    const task = runningTask;
    runningTask = null;
    if (!task || localIdentity(ctx)?.key !== task.fence.ref.key || !valid(task.fence)) return;
    asks.clear();
    await send("OMP authorized session finished.", task.fence);
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    if (event.toolName !== "ask" || localIdentity(ctx)?.key !== current?.key) return;
    const fence = snapshot(true);
    if (!fence) return;
    const args = event.args as { questions?: { question: string; options: { label: string }[] }[] };
    if (!Array.isArray(args?.questions)) return;
    for (const question of args.questions) {
      if (typeof question.question !== "string" || !Array.isArray(question.options)) continue;
      const keyboard: { text: string; callback_data: string }[][] = [];
      for (const [index, option] of question.options.entries()) {
        if (typeof option.label !== "string") continue;
        const token = randomUUID().replaceAll("-", "").slice(0, 16);
        asks.set(token, {
          fence,
          tool: event.toolCallId,
          question: question.question,
          option: option.label,
        });
        keyboard.push([{ text: `Choice ${index + 1}`, callback_data: `a:${instance}:${token}` }]);
      }
      await send(
        "OMP is waiting for input. Review the question and choices in the local terminal. A Telegram choice queues a follow-up prompt; it does not resolve the native ask dialog.",
        fence,
        keyboard,
      );
      if (!valid(fence)) return;
    }
  });
  pi.on("tool_execution_end", async (event) => {
    for (const [token, ask] of asks) if (ask.tool === event.toolCallId) asks.delete(token);
  });
  pi.on("session_shutdown", async () => {
    stopped = true;
    invalidate();
    stopTimer();
    if (!configured) return;
    try {
      store.change((reg) => {
        delete reg.instances[instance];
        if (reg.leader === instance) {
          reg.leader = null;
          reg.leaderEpoch = randomUUID();
        }
        if (reg.controller?.instance === instance) reg.controller = null;
      });
    } catch {
      /* A crash/failure is recovered through the heartbeat lease. */
    }
  });
}

export default function telegram(pi: ExtensionAPI): void {
  createTelegramExtension(pi);
}
