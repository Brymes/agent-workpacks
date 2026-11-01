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

## Questions and escalation

Workers communicate through `QUESTIONS.md`; the deterministic sweep renders open work into
`control/ESCALATIONS.md`. The recorded lead handles in-scope engineering questions, routine review and worker
corrections. The owner handles scope, business, credential, merge and deployment decisions.

### Question format

```markdown
## Q-<PFX>-<ID>-NNN <short title> [senior|owner|orchestrator]
- Why it matters: ...
- Options: ...
- Recommendation: ...
- Blocks: ...

**A (senior, <HH:MM>):** ...
```

Allocate IDs with `pack-next-id.mjs`. Never rewrite an answered question; add another question when new evidence
changes the issue.

### Handling questions

1. Read the escalation packet, BRIEF, STATUS, REPORT and QUESTIONS. Read other pack context or bounded source only
   when needed.
2. Answer decisions already established by GOAL, PLAN, RULES and the approved brief.
3. If the answer would change scope, ownership, a contract or an owner-level decision, record the request in
   CURRENT.md and stop that path.
4. Write the answer under the question, then use `pack-worker instruct` so the saved native session continues.
5. Acknowledge the sweep item while it is being handled. The next sweep resolves it when the underlying condition
   clears.

The senior does not edit product code, merge, deploy, or launch another senior controller from a watcher-triggered
turn. If the assignment itself is wrong, create a new validated assignment; do not silently rewrite ownership.

## Sweep behavior

`pack-sweep.mjs` is deterministic and calls no model. It reads the roster, current attempt log slice, process
liveness, STATUS, REPORT, QUESTIONS, dependencies, checkout diff and optional probe records. The supervisor records
stdout/stderr offsets for each attempt. Older provider errors, loop events and session IDs remain in aggregate logs
but do not affect a recovered attempt.

### Action classes

| Class | Meaning | Normal senior action |
|---|---|---|
| `probe-failed` | recent diagnostic or real launch shows provider/auth/quota failure | stop refilling that model; diagnose or ask owner |
| `launch-failed` | worker could not start useful work | inspect launch log; probe if useful; retry once |
| `blocked` | declared repair allowance or blocker is exhausted | stop and escalate |
| `needs-senior` | open question or owner-needed status | answer durably, then resume the same session |
| `out-of-scope-writes` | checkout diff exceeds Owns | stop and reassign or issue a new assignment |
| `doom-loop` | repeated calls or text-only loop in this attempt | stop and send a narrower correction |
| `running-stale` | live process has no recent current-attempt activity | inspect tail, correct or stop |
| `exited-no-report` | process ended without a valid handback | inspect checkout and resume the same session |
| `exited-ok-needs-review` | REPORT and needs-review are present | review, correct or accept |
| `ready-to-start` | dependencies are done and task has not launched | start when capacity and memory allow |
| `running-healthy`, `queued`, `done`, `stopped`, `parked` | no immediate intervention | none |

A provider probe is diagnostic. Missing, malformed or stale probe data does not block a normal start. A matching,
recent failed probe blocks new launches for that model. Same-session corrections never require a probe. A real
provider/auth/quota failure in the current launch remains actionable even without a probe.

### Identities and acknowledgement

An open item identity includes task, attempt generation, class, recipient and the relevant question, blocker,
ownership or assignment identity. Elapsed age and changing prose stay outside the fingerprint. A later correction
therefore creates a new review item, while time passing alone cannot reopen an acknowledged stale alert.

`pack-worker ack --escalation <E-id>` marks work as actively handled. The item stays visible until the condition
clears. Sweep resolves superseded items instead of deleting history. Both operations use the same lock.

Exit codes are 0 for no actionable item, 10 when action is open, and 2 for a sweep error. With `--changed-only`,
only unacknowledged items cause exit 10.


Queued delivery fingerprints sorted action identities and records delivery only after success, so failures remain
retryable. Queued prompts contain no worker-supplied text. Native waiters are level-triggered: an unacknowledged
action wakes the session at its first sweep.
