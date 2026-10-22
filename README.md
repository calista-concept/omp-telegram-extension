# omp Telegram Bridge

Control [omp](https://github.com/oh-my-pi/omp) from Telegram. Send prompts from your phone, watch the agent work in real time, get notified when it finishes — and see tasks you started in the terminal right in your chat.

```
You:  fix the failing tests in src/auth
Bot:  🚀 OMP started (from the terminal)
      📋 fix the failing tests in src/auth
      Send /status for progress or /stop to cancel.

Bot:  📋 Agent plan (3/7)
      🔄 Fix token expiry check
      ⬜ Update middleware tests
      ⬜ Regenerate fixtures

Bot:  ✅ OMP finished
      ⏱ 4m 12s
      📝 Result:
      All 14 tests pass. The expiry check now ...
```

## Features

- **Two-way prompts** — messages you send in Telegram become omp prompts; the agent's final answer is delivered back to the chat.
- **Terminal tasks are visible** — start a task in your terminal and the bot still announces it, streams todo/plan progress, and notifies you on completion. Telegram is a full control surface, not just a prompt box.
- **`/status`** — what every omp instance is doing right now (prompt, elapsed time, working directory), across all running instances.
- **`/stop`** — abort the running task, even if it was started in a terminal or in another omp instance.
- **Live plan tracking** — when the agent uses its todo tool, the bot posts a plan message and edits it as items complete.
- **Ask-tool mirroring** — when the agent asks a question with options, it appears in Telegram as inline buttons; tap one and your answer is fed back to the agent.
- **Multi-instance aware** — run omp in several projects at once. One instance polls Telegram; the others stand by. Commands route to whichever instance owns the running task, and if the polling instance dies or hangs, a standby takes over within ~30 seconds.
- **Rich formatting** — replies render Telegram HTML: headings, bold, code blocks with syntax highlighting, links, quotes.

## Commands

| Command | Description |
|---|---|
| `/start` or `hello` | Connection test |
| `/status` | All running tasks across all omp instances |
| `/stop` | Stop the current task (local or remote instance) |
| `/instances` | List live omp instances; tap to switch which one polls Telegram |
| `/use <n>` | Switch the active poller to instance *n* |
| `/sessions` | List recent omp sessions |
| `/resume <n>` | Switch this instance to a recent session |
| `/new` | Start a fresh session in this instance |
| `/tg` | One-time arming command in the omp terminal — enables session switching from Telegram |

## Requirements

- [omp](https://github.com/oh-my-pi/omp) installed (`omp --version` to check)
- A Telegram bot token (via [@BotFather](https://t.me/BotFather) — see below)
- Your Telegram user id (see below)

## Setup

### 1. Create a bot with @BotFather

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Choose a display name (e.g. `My OMP Bridge`).
4. Choose a username — must end in `bot` (e.g. `paneww_omp_bot`).
5. BotFather replies with a **token** like:
   ```
   123456789:AAHKDiUXZoudb0wq0nlJO7hWKzYzR0PR7iE
   ```
   Keep it secret — anyone with the token can control your bot.

Optional but recommended: in BotFather, send `/setprivacy` → select your bot → **Disable**, so the bot can receive all messages (the bridge only processes messages from your user id anyway).

### 2. Get your Telegram user id

The bridge only accepts commands from one user id (yours). To find it:

1. Message [@userinfobot](https://t.me/userinfobot) — it replies with your `Id` immediately; or
2. Message [@RawDataBot](https://t.me/RawDataBot) and look for `"id"` under `chat` / `from`; or
3. Start the bridge with a placeholder id (step 3), send any message to your bot, and copy the id from the log line `[telegram] Ignoring unauthorized user <id>`.

> Note: the id is a number like `1087156700` — **not** your @username.

### 3. Configure environment variables

Add to your shell profile (`~/.zshrc`, `~/.bashrc`, …):

```bash
export OMP_TELEGRAM_BOT_TOKEN="123456789:AAHKDiUXZoudb0wq0nlJO7hWKzYzR0PR7iE"
export OMP_TELEGRAM_USER_ID="1087156700"
```

Then `source ~/.zshrc` (or open a new terminal).

`OMP_TELEGRAM_BOT_TOKEN` is **required** — without it the extension logs `[telegram] Missing OMP_TELEGRAM_BOT_TOKEN` and stays inactive. `OMP_TELEGRAM_USER_ID` is **required** for anyone other than the author (the author's id is used as fallback for backwards compatibility).

### 4. Install the extension

Copy the extension file into omp's extensions directory:

```bash
mkdir -p ~/.omp/agent/extensions
curl -o ~/.omp/agent/extensions/telegram.ts \
  https://raw.githubusercontent.com/calista-concept/omp-telegram-extension/main/telegram.ts
```

Or clone and symlink, if you prefer to track updates:

```bash
git clone https://github.com/calista-concept/omp-telegram-extension.git ~/.omp/omp-telegram-bridge
mkdir -p ~/.omp/agent/extensions
ln -s ~/.omp/omp-telegram-bridge/telegram.ts ~/.omp/agent/extensions/telegram.ts
```

### 5. Arm session switching (one-time, per machine)

omp only exposes session-switching APIs to command handlers, so the bridge uses a tiny helper command:

1. Start omp in any project: `omp`
2. Type `/tg` once

You'll see `[telegram] Command context captured via /tg` in the omp log. This arms `/new` and `/resume <n>` from Telegram. It persists for the lifetime of that omp instance — rerun `/tg` after restarting omp.

### 6. Test it

1. Open your bot in Telegram, send `hello` → the bot replies `🤖 OMP Telegram bridge is working!`
2. Start omp in a project, send `what files changed recently?` → the bot announces the task and replies with the result when done.

## Multi-instance behavior

Run omp in as many projects as you like. The extensions coordinate through a shared registry file (`~/.omp/telegram-bridge.json`):

- Exactly one instance **polls Telegram** (the leader, 🟢 in `/instances`); the others stand by.
- A task running in *any* instance shows up in `/status` and can be stopped with `/stop` — the command is routed to the instance that owns the task.
- Ask-poll button taps are routed the same way.
- If the leader's process dies — or freezes (stale heartbeat for >30 s) — a standby takes over automatically and adopts the message offset, so no messages are lost.

`/instances` lists everything with a `Switch to …` button to hand the poller role to another instance (useful when you want the bot tied to a specific project's session).

## Security notes

- **Only your user id** is accepted; every other sender is ignored and logged.
- The bot token grants full control of the bot — store it in your shell profile, not in the repo.
- Anyone with the token *and* ability to run commands on your machine could impersonate you; treat the token like a password.
- The registry file (`~/.omp/telegram-bridge.json`) contains no secrets — just pids, prompts, and chat ids.

## Files

| Path | Purpose |
|---|---|
| `~/.omp/agent/extensions/telegram.ts` | The extension (single file, no dependencies beyond omp itself) |
| `~/.omp/telegram-bridge.json` | Shared coordination registry (auto-created) |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `[telegram] Missing OMP_TELEGRAM_BOT_TOKEN` in the omp log | `OMP_TELEGRAM_BOT_TOKEN` isn't set in the environment omp sees. Export it in the shell profile and restart omp. |
| Bot replies nothing, log shows `Ignoring unauthorized user <id>` | Put that id in `OMP_TELEGRAM_USER_ID` and restart omp. |
| `409 Conflict` from getUpdates in the log | Another process (or an old omp instance) is polling with the same token. Stop it, or `/use` another instance. |
| `/resume` or `/new` says session switching isn't armed | Run `/tg` once in that instance's terminal, then retry. |
| Terminal task started but no notification | The bridge notifies the last chat that talked to the bot. Send `hello` once from Telegram first. |
| Two omp instances, but `/status` shows only one | The second instance was started before the extension loaded — restart it so it registers. |

## License

MIT
