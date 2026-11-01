# Lead monitoring

Use the shared changed-only sweep. A quiet interval calls no model. An action is acknowledged only after the lead
has begun handling it. The CLI's background notification is a wake-up, never owner approval.

## Bind one lead

```sh
node <skill>/scripts/pack-watch.mjs attach --pack <pack> --host codex --session <native-session-id>
node <skill>/scripts/pack-watch.mjs attach --pack <pack> --host claude --session <native-session-id>
node <skill>/scripts/pack-watch.mjs attach --pack <pack> --host opencode --session <native-session-id>
```

Run the one command matching the current lead. Use the session ID from the host, not a worker ID. Codex can omit
`--session` when CODEX_THREAD_ID is available, and retains the `--thread` alias. Native hosts can use their session
context or select the current session from the CLI's session listing. Never guess another session's identity.

Changing host or session requires `--takeover`. Check status before dispatch. Takeover stops recorded previous
monitoring processes, keeps binding history, and makes unresolved work eligible for the new lead.

## Codex

Attach installs the existing 15-minute macOS LaunchAgent. On Linux it starts a detached no-model Node watcher loop.
Use `--no-install` to bind without scheduling. `pack-watch.mjs run --pack <pack> --interval-sec 900` runs that portable
loop explicitly. Each tick queues one fixed prompt with `codex queue` when new unacknowledged actions exist. Failed
delivery remains retryable. Keep the Codex app/session available; a stopped watcher does not reopen it automatically.

## Claude and OpenCode

After binding, run this same command through the host's shell tool:

```sh
node <skill>/scripts/pack-watch.mjs wait --pack <pack> --host claude --interval-sec 180 --timeout-min 60
```

For Claude use Bash `run_in_background: true`. For OpenCode change `--host` to `opencode` and use shell
`background: true`. The host notifies its originating session when the command ends. Do not substitute `nohup`,
a trailing `&`, or a second detached lead: these would lose the native completion callback. Re-arm after handling a wake.

| Exit | Event | Action |
|---|---|---|
| 10 | action | Read affected files, review/answer/dispatch, acknowledge, re-arm. |
| 11 | file | Read the changed `--also-watch` file, act, re-arm. |
| 0 | heartbeat | Quiet timeout; re-arm if work remains. |
| 2 | error | Read the error and run the sweep manually to diagnose. |

`--also-watch <file>` is repeatable. Files rewritten by the sweep are refused to prevent self-triggering. Exactly one
waiter is allowed per pack. An unacknowledged action wakes a waiter immediately, so acknowledge before re-arming.

## Status, completion and recovery

Use `pack-watch.mjs status --pack <pack>` to inspect binding and delivery; use `disable` on completion. Native
background callbacks require the originating host session to remain available. If it closes, reopen the session or
explicitly take over from the files and re-arm. Codex heartbeat automations are optional and cost a turn even when quiet;
if one was created separately, pause it when disabling the pack. Monitoring never creates one automatically.
