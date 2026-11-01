# Sweep and watcher behavior

`pack-sweep.mjs` is deterministic and calls no model. It reads the roster, current attempt log slice, process
liveness, STATUS, REPORT, QUESTIONS, dependencies, checkout diff and optional probe records. The supervisor records
stdout/stderr offsets for each attempt. Older provider errors, loop events and session IDs remain in aggregate logs
but do not affect a recovered attempt.

## Action classes

| Class | Meaning | Normal senior action |
|---|---|---|
| `probe-failed` | recent diagnostic or real launch shows provider/auth/quota failure | stop refilling that model; diagnose or ask owner |
| `launch-failed` | worker never began a step after one retry | inspect launch log; probe if useful; retry once |
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

## Identities and acknowledgement

An open item identity includes task, attempt generation, class, recipient and the relevant question, blocker,
ownership or assignment identity. Elapsed age and changing prose stay outside the fingerprint. A later correction
therefore creates a new review item, while time passing alone cannot reopen an acknowledged stale alert.

`pack-worker ack --escalation <E-id>` marks work as actively handled. The item stays visible until the condition
clears. Sweep resolves superseded items instead of deleting history. Both operations use the same lock.

Exit codes are 0 for no actionable item, 10 when action is open, and 2 for a sweep error. With `--changed-only`,
only unacknowledged items cause exit 10.

## Watcher delivery

`pack-watch.mjs tick` fingerprints the sorted unacknowledged item identities. It queues each unchanged set once to
the bound Codex thread, recording delivery only after `codex queue` succeeds. Failure remains retryable and raises a
local notification. The queued prompt contains no worker text and instructs the senior to read the files.

The 15-minute LaunchAgent tick has no model cost when quiet. A 30-minute same-chat Codex heartbeat is a fallback and
consumes a subscription turn on every invocation, including a quiet one. Both paths target the one recorded senior
thread; neither starts another controller.

A Claude senior uses `pack-watch.mjs wait` instead (see [claude-senior.md](claude-senior.md)). It runs the same
changed-only sweep on an interval and exits 10 while any item is unacknowledged. There is no fingerprint: the
senior acknowledges handled items before re-arming, or the next waiter wakes it again at its first sweep.
