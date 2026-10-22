import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { createTelegramExtension, type TelegramRegistry } from "../telegram";

export const FAKE_ENV = {
  OMP_TELEGRAM_BOT_TOKEN: `123456:${"x".repeat(35)}`,
  OMP_TELEGRAM_USER_ID: "777",
};
type Call = { method: string; body: Record<string, unknown>; signal: AbortSignal };
type Handler = (event: Record<string, unknown>, context: ExtensionCommandContext) => unknown;
type Command = { handler: (args: string, context: ExtensionCommandContext) => unknown };
export async function settle(): Promise<void> {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}
export class Harness {
  readonly root = mkdtempSync(path.join(tmpdir(), "omp-telegram-test-"));
  readonly sessions = path.join(this.root, "sessions");
  readonly directory = path.join(this.root, "private");
  clock = 1_000_000;
  sequence = 0;
  calls: Call[] = [];
  updates: unknown[] = [];
  live = new Set<number>();
  timers = new Map<number, { pid: number; callback: () => void }>();
  timerSequence = 0;
  hook?: (call: Call) => Promise<Response> | Response | undefined;
  constructor() {
    mkdirSync(this.sessions);
  }
  session(id: string, saved = true): { id: string; file: string } {
    const session = { id, file: path.join(this.sessions, `${id}.jsonl`) };
    if (saved) this.materialize(session);
    return session;
  }
  materialize(session: { id: string; file: string }): void {
    writeFileSync(
      session.file,
      JSON.stringify({
        type: "session",
        id: session.id,
        timestamp: `2026-01-01T00:00:${session.id}.000Z`,
        cwd: "/private/research",
      }) + "\n",
      { mode: 0o600 },
    );
  }
  message(text: string, from = 777, chat = 777): void {
    this.updates.push({
      update_id: ++this.sequence,
      message: {
        from: { id: from },
        chat: { id: chat, type: chat === 777 ? "private" : "group" },
        text,
      },
    });
  }
  callback(data: string, from = 777): void {
    this.updates.push({
      update_id: ++this.sequence,
      callback_query: {
        id: `callback-${this.sequence}`,
        from: { id: from },
        message: { chat: { id: 777, type: "private" } },
        data,
      },
    });
  }
  response(result: unknown = []): Response {
    return Response.json({ ok: true, result });
  }
  registryFile(): string {
    const namespace = readdirSync(this.directory)[0];
    return path.join(this.directory, namespace, "registry.json");
  }
  registry(): TelegramRegistry {
    return JSON.parse(readFileSync(this.registryFile(), "utf8"));
  }
  mutate(mutator: (registry: TelegramRegistry) => void): void {
    const registry = this.registry();
    mutator(registry);
    writeFileSync(this.registryFile(), JSON.stringify(registry), { mode: 0o600 });
  }
  sent(): Record<string, unknown>[] {
    return this.calls.filter((call) => call.method === "sendMessage").map((call) => call.body);
  }
  async tick(): Promise<void> {
    for (const { callback } of this.timers.values()) callback();
    await settle();
  }
  async deliver(text: string, from = 777, chat = 777): Promise<void> {
    this.message(text, from, chat);
    await this.tick();
    await this.tick();
  }
  bridge(
    session: { id: string; file: string },
    pid = 100,
    env: Record<string, string | undefined> = FAKE_ENV,
  ): Bridge {
    this.live.add(pid);
    return new Bridge(this, session, pid, env);
  }
  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
export class Bridge {
  events = new Map<string, Handler[]>();
  commands = new Map<string, Command>();
  notices: string[] = [];
  prompts: string[] = [];
  anchors: { type: string; data: unknown }[] = [];
  aborts = 0;
  newCount = 0;
  switches: string[] = [];
  idle = true;
  beforeTransition?: () => Promise<void>;
  session: { id: string; file: string };
  readonly context: ExtensionCommandContext;
  constructor(
    readonly harness: Harness,
    session: { id: string; file: string },
    readonly pid: number,
    env: Record<string, string | undefined>,
  ) {
    this.session = session;
    this.context = {
      cwd: "/same/cwd",
      ui: {
        notify: (text: string) => {
          this.notices.push(text);
        },
      },
      sessionManager: {
        getSessionId: () => this.session.id,
        getSessionFile: () => this.session.file,
      },
      isIdle: () => this.idle,
      abort: () => {
        this.aborts++;
      },
      newSession: async () => {
        if (!(await this.allowTransition("new"))) return { cancelled: true };
        this.newCount++;
        const next = harness.session(`new-${pid}-${this.newCount}`);
        await this.switch(next, "new");
        return { cancelled: false };
      },
      switchSession: async (file: string) => {
        if (!(await this.allowTransition("resume", file))) return { cancelled: true };
        this.switches.push(file);
        const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]);
        await this.switch({ id: header.id, file }, "resume");
        return { cancelled: false };
      },
    } as unknown as ExtensionCommandContext;
    const api = {
      registerCommand: (name: string, command: Command) => {
        this.commands.set(name, command);
      },
      on: (name: string, handler: Handler) => {
        this.events.set(name, [...(this.events.get(name) ?? []), handler]);
      },
      appendEntry: (type: string, data: unknown) => {
        this.anchors.push({ type, data });
      },
      sendUserMessage: async (prompt: string) => {
        this.prompts.push(prompt);
      },
    } as unknown as ExtensionAPI;
    createTelegramExtension(api, {
      env,
      directory: harness.directory,
      pid,
      alive: (pid) => harness.live.has(pid),
      now: () => harness.clock,
      interval: (callback) => {
        const id = ++harness.timerSequence;
        harness.timers.set(id, { pid, callback });
        return id as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: ((id: number) => {
        harness.timers.delete(id);
      }) as unknown as typeof clearInterval,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const call = {
          method: String(url).split("/").at(-1)!,
          body: JSON.parse(String(init?.body)),
          signal: init?.signal as AbortSignal,
        };
        harness.calls.push(call);
        const hooked = harness.hook?.(call);
        if (hooked) return await hooked;
        return call.method === "getUpdates"
          ? harness.response(harness.updates.splice(0))
          : harness.response({ message_id: harness.calls.length });
      }) as typeof fetch,
    });
  }
  private async allowTransition(reason: string, targetSessionFile?: string): Promise<boolean> {
    await this.beforeTransition?.();
    for (const handler of this.events.get("session_before_switch") ?? []) {
      const result = await handler({ reason, targetSessionFile }, this.context);
      if (
        typeof result === "object" &&
        result !== null &&
        "cancel" in result &&
        result.cancel === true
      )
        return false;
    }
    return true;
  }
  async emit(name: string, event: Record<string, unknown> = {}): Promise<void> {
    for (const handler of this.events.get(name) ?? []) await handler(event, this.context);
    await settle();
  }
  async start(): Promise<void> {
    await this.emit("session_start");
  }
  async command(args: string, name = "telegram"): Promise<void> {
    await this.commands.get(name)!.handler(args, this.context);
    await settle();
  }
  async switch(session: { id: string; file: string }, reason = "resume"): Promise<void> {
    this.session = session;
    await this.emit("session_switch", { reason });
  }
  async shutdown(): Promise<void> {
    await this.emit("session_shutdown");
  }
}
