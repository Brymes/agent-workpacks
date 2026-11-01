# Pack files and writers

A pack is a directory that lets a different senior recover the campaign without the previous chat. Existing packs
remain valid; no migration is required.

## Core files

| Path | Purpose | Primary writer |
|---|---|---|
| `GOAL.md` | outcome and acceptance | senior |
| `PLAN.md` | task board, dependencies and ownership | senior |
| `RULES.md` | pack-specific authority and constraints | senior / owner |
| `control/CURRENT.md` | plain current state and next action | senior; sweep owns its marked table |
| `control/roster.json` | task assignment, process, native worker session and attempts | controller scripts |
| `control/ESCALATIONS.md` | rendered actions and decisions | sweep |
| `tasks/<ID>/BRIEF.md` | immutable accepted assignment | senior |
| `tasks/<ID>/STATUS.md` | state, timestamp, blocker and next action | worker |
| `tasks/<ID>/REPORT.md` | result, files, commands/results and remaining work | worker |
| `tasks/<ID>/QUESTIONS.md` | durable questions and answers | worker / senior / owner |

`CONTEXT.md`, `DECISIONS.md`, `ACCEPTANCE.md`, `REVIEW-CHECKLIST.md`, `LEDGER.md`, `evidence/` and `review/` remain
supported. New tasks do not need to read an empty auxiliary file.

## Configuration

`control/config.json` holds pack paths, merge mode, protected branches, role-to-model and role-to-agent mappings,
and limits. The default worker capacity is ten. Each launch still passes the configured memory gate.

```json
{
  "version": 1,
  "root": "/path/to/workspace",
  "pack": "/absolute/path/to/topic-pack-v1",
  "pfx": "TOP",
  "limits": { "max_workers": 10, "memory_gate_min_free_pct": 25 },
  "models": {
    "coder": "opencode-go/deepseek-v4.1-flash",
    "researcher": "opencode-go/glm-5.3-flash",
    "verifier": "opencode-go/deepseek-v4.1-flash",
    "docs": "opencode-go/glm-5.3-flash"
  },
  "agents": {
    "coder": "dp-coder",
    "researcher": "dp-researcher",
    "verifier": "dp-verifier",
    "docs": "dp-researcher"
  }
}
```

## Roster

A new task row records assignment (`id`, role, model, checkout, branch/base, ownership, dependencies, brief digest
and launch-contract snapshot), runtime (`pid`, state and current attempt), and OpenCode continuity (`session_id` and
`previous_sessions`). Attempt history stores stdout/stderr start offsets so status and sweep classify only the
current attempt while aggregate logs remain available.

Old rows may contain legacy backend fields such as `session_key`, `run_id` or other unknown properties. Readers
preserve them, but new OpenCode tasks do not create or depend on them.

## Senior binding

`control/senior.json` records the lead host, native session, waiter or watcher identity, delivery state, and takeover history.
Native hosts bind before arming their waiter; Codex also supports legacy thread_id bindings. Old roster tool values
that are absent mean OpenCode; new records explicitly select opencode, claude, or codex. Unknown fields are preserved.
