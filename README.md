# OMP Telegram session bridge

Version 2 is a **fail-closed breaking security change** for OMP 18.12.6. Telegram is OFF for every new, forked, or recreated session, including sessions sharing a process or working directory. Merely loading the extension, configuring a bot, selecting a poller, or capturing a command context never authorizes a session. Control permission authorizes inbound actions, never publication of native session content.

## Local commands

Run these commands in the OMP terminal, not Telegram:

| Command | Effect on the exact current session |
| --- | --- |
| `/telegram` or `/telegram on` | Enable generic working/completion/status notifications; reset remote control to OFF |
| `/telegram off` | Revoke notifications and control, invalidate queued work and abort in-flight requests |
| `/telegram status` | Report local configuration and permissions; works with no credentials |
| `/telegram test` | Send a fixed content-free test notification, only if this session is enabled |
| `/telegram control on` | Separately authorize inbound prompts, opaque ask choices and remote session operations; notifications must already be ON |
| `/telegram control off` | Remove control permission while retaining generic notifications |

Version 2 replaces the old `/tg` command rather than retaining its global-control semantics or a deprecated shim. `/telegram on` deliberately resets a previously granted control permission; enabling notifications is never an implicit control grant.

Local permission commands reconcile session identity without starting a poll or draining an inbox first. Their permission changes therefore take precedence over authorized remote work that was queued but not yet invoked.

Lifecycle notifications contain only fixed working/finished text **in every mode, including control ON**. The bridge never exports native session titles, prompts, answers, paths, files, source, research, plans, credentials, tool arguments, ask questions, native option labels or working directories. Control is not a content-publication grant, and there is no content-export command. Test messages likewise contain no session content. A completed HTTP request is not proof of delivery; the local test result says so explicitly.

## Credentials and installation

The bridge requires both `OMP_TELEGRAM_BOT_TOKEN` and an explicitly configured positive integer `OMP_TELEGRAM_USER_ID`. There is **no author-ID fallback**. Invalid or missing credentials mean no Telegram requests, no polling/standby timers and no registry creation or disclosure. Local commands remain available. The extension never asks for credentials in a prompt, logs tokens, logs Telegram response bodies, or emits token-containing URLs/errors.

Obtain credentials independently from Telegram's native bot/account interfaces. Supply them securely in the environment of the OMP process; do not place real values in source, Git, a session prompt, shell history, screenshots, or a shared configuration. Protect the parent launch environment. Reloading an extension or restarting an OMP process is an operator decision; this repository does not modify a live installation.

Optional macOS integration: an operator-owned launcher may retrieve an already stored bot token from the **local macOS Keychain** using the native `security find-generic-password -w` interface and export it only to its child OMP process. Use an operator-chosen service/account; the extension does not create Keychain items, implement OAuth, copy credentials, or provide a real-value configuration. Do not print the value or enable shell tracing. A Keychain access failure must leave the credential absent, not select another account or a fallback token.

Install the reviewed `telegram.ts` through OMP's normal local extension loading mechanism (for example a local extension file or symlink). No runtime dependency beyond OMP and Bun's Node-compatible APIs is needed. Do not install an older upstream version over this fork: its trust model is incompatible.

After installation, configure credentials outside OMP, open the intended session, and enable `/telegram on` locally. `/telegram test` sends directly to the explicit user's private chat; no remembered last chat or Telegram handshake is trusted. Group/channel chats are rejected even when their sender matches the configured user.

## Session identity and persistence

Durable grants bind the native session header ID and creation timestamp **and the transcript file incarnation** (device, inode and birth time), not cwd, process ID, title or a pathname alone. Normal resume/restart of that exact session preserves its separately granted permissions. Title changes and a filesystem rename retaining the same incarnation do not grant a different session access. A moved current session updates its known grant path on the next native event/heartbeat. If another instance observes a missing path during a relocation, access may be conservatively revoked; re-enable locally rather than inferring a replacement identity. Deletion/recreation or replacement of the file, even with copied header contents, is OFF. A native operation that atomically replaces a transcript's incarnation also requires local reauthorization. This conservative boundary is intentional.

OMP can advertise a session file before physically creating it. Enabling that unsaved session appends a small native custom anchor (native ID and random nonce, no credentials) and creates an **ephemeral instance/native-ID-bound grant**. It does not manufacture a user/assistant message or contact a provider. Once that same live native session materializes, its grant is promoted to the durable identity; another/forked native ID cannot inherit it. An unsaved session that shuts down has no resumable transcript and therefore no recoverable grant. A reload/restart cannot recover an orphaned pending grant.

Fork/new/session-branch events invalidate pending operations. New/forked identities remain OFF even if native history contains a copied custom anchor. Authorization is never recovered by searching session directories. Remote listings inspect only already authorized grant records.

## Remote commands (explicit control required)

Only the explicitly configured sender in that same private user chat is accepted. Every command, inbox item and callback rechecks its precise controlling session, target session, instance nonce, live lease, grant revision and session epoch immediately before effects. Revocation or switching invalidates stale callbacks, queued inbox work, asynchronous poll batches and later message chunks. Aborting an HTTP request cannot retract a fixed notification already delivered to Telegram; no native session content is included even before revocation.

| Telegram command | Behavior |
| --- | --- |
| `/status`, `/start` | Generic idle/working response for the selected authorized control session |
| `/stop` | Abort only the selected authorized session, never broadcast to all tasks |
| Plain text | Queue a prompt only in the selected explicitly control-authorized session |
| `/instances` | List opaque IDs of live control-authorized instances only |
| `/use <instance-id>` | Select an already authorized controlling instance; never authorize a target or inherit access from poller ownership |
| `/sessions` | List opaque IDs of existing, explicitly control-authorized sessions only; no title/cwd/path enumeration |
| `/resume <session-id>` | Resume only a separately control-authorized target, from an authorized controlling session |
| `/new` | Create a session that is OFF; no success message or subsequent prompt is sent from the new unauthorized session |

In notifications-only mode, `/status` produces a fixed content-free notification-mode response. Other inbound commands, asks and callbacks have no effect. Unknown slash commands are ignored, not submitted as prompts. Numeric menu indices and legacy `inst:`, `sess:` and `ask:` callbacks are intentionally unsupported: an old menu must not accidentally select a different current session.

Remote new/resume additionally require an idle target and a command context captured by an authorized local `/telegram control on` command in that exact session. Switching does not auto-arm the destination. No remote operation is cached to execute after a future local enable command.

The precise session and grants are checked immediately before invoking native new/resume; that authorized invocation is the native effect's linearization point. Authorization is checked again in OMP's `session_before_switch` cancellation hook for a delayed invocation. OMP 18.12.6 exposes no AbortSignal/commit guard for an already accepted native transition, so revocation does not retroactively roll it back during OMP's internal awaits. Revocation still rejects not-yet-invoked work, suppresses every subsequent Telegram effect, and leaves a new session OFF.

Control ON enables only a generic waiting-for-input notification and opaque `Choice 1`, `Choice 2`, … buttons for native asks. Questions, option labels and descriptions remain local; review the question and choice ordering in OMP's terminal before selecting a button. The question/option mapping stays in memory in the owning instance, never in a Telegram payload or standing registry metadata. A button queues the mapped follow-up user prompt locally; it **does not resolve OMP's native ask dialog**. Terminal answers/tool completion expire its buttons. Buttons are single-use and cannot select another instance/session through a stale index. Assistant answers and todo plans are never exported, whether control is ON or OFF.

## Private multi-instance coordination

Each bot/user pair has a hash-namespaced registry under `~/.omp/telegram-private/` (directory mode `0700`, files `0600`). The namespace is not a credential. The registry stores only grant/file-identity bindings, ephemeral instance references/leases, the Telegram update cursor, leader/controller references, and short-lived inbox envelopes. It does not publish cwd, titles, prompts, answers, task text or ask content as standing instance metadata. A pending authorized inbound prompt can exist briefly in a private inbox until consumed; treat the directory as private local state, not an exportable diagnostics file. Revocation tombstones contain no content and prevent stale persisted grants from returning even when registry-lock contention prevents cleanup.

Short synchronous transactions use an exclusive directory lock and atomic registry replacement. Dead-owner lock reclamation elects one reaper by unlinking that unique owner's file before removing the lock directory. A live or ownerless lock fails closed; a local operator may recover an ownerless lock **only after confirming all bridge instances are stopped**. There is no unsafe age-only lock stealing.

Only one lease-elected instance polls a bot; authorized standbys consume their own fenced inboxes and can take over after a dead/stale leader. Poll responses recheck leadership epochs before routing or committing the shared cursor. `/use` changes the controller, not access grants. Poller leadership itself carries no target-session permission. The first activation drops old Telegram backlog; later leaders adopt the shared cursor. Telegram transport is not an exactly-once message queue: a crash between delivery and cursor persistence can lose or replay an update. All replayed effects still require current authorization. The bridge deliberately does not claim remote control or real delivery has been verified merely because registry configuration exists.

## Migration from upstream v1

1. Stop/reload older bridge instances through your normal maintenance procedure; do not run old and new trust models against the same bot concurrently.
2. Do not import the old `~/.omp/telegram-bridge.json`: it contains global last-chat, cwd, prompt and instance state, not trustworthy session grants. This fork neither reads nor rewrites it. Remove/archive that sensitive old file locally if appropriate.
3. Configure both explicit environment credentials securely. The old personal author-ID fallback is gone.
4. Every session initially remains OFF. Enable notifications locally per intended session, then separately enable control only for sessions you intend to expose to Telegram.
5. Replace `/tg` with `/telegram`, and replace old numbered menus/callbacks with the new opaque authorized IDs. There is no one-time global arming or deprecated command shim.
6. Automatic assistant-answer and todo-plan exports are intentionally removed, even with control ON. Native ask text/labels are replaced with fixed waiting text and opaque numbered choices. There is no replacement content-export permission.

## Deterministic tests

`test/` drives the actual extension's registered commands/events, mocked Telegram transport, private on-disk registry, injected clock/liveness and manual interval callbacks. Every fixture uses a fresh temporary directory; no test reads a real home, live OMP config, Telegram credentials or Telegram network. Coverage includes default OFF, same-process/cwd A/B isolation, durable resume/restart, pending unsaved identity promotion, forks/deletion/recreation, separate control, sender/chat denial, opaque listings, remote new/resume, callback/inbox fencing, local revocation priority, pending-request AbortSignal fencing, leader failover/cursor adoption and lock contention. Consumer-visible payload assertions verify that even control ON never publishes sentinel prompts, answers, source, credentials, tool arguments or native ask labels, while opaque choices still map to the correct local follow-up.

Verified with Bun 1.3.14, OMP SDK 18.12.6 and TypeScript 5.9.3: all 32 deterministic tests pass (153 assertions), typecheck and Bun bundle pass. The real patched native CLI also loads the extension and executes `/telegram status` as unconfigured/OFF with zero agent turns. A separate Codex OAuth identity completed an independent focused security review with no material findings. Run `bun run test` and `bun --bun run typecheck` to reproduce the package gates. Real Telegram account/device delivery is not tested; no bot credentials or live configuration are included.

## License

MIT
