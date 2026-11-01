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
  "agents": {}
}
```

## Roster

A new task row records assignment (`id`, role, model, checkout, branch/base, ownership, dependencies, brief digest
and launch-contract snapshot), runtime (`pid`, state and current attempt), and native session continuity (`session_id` and
`previous_sessions`). Attempt history stores stdout/stderr start offsets so status and sweep classify only the
current attempt while aggregate logs remain available.

Old rows may contain legacy backend fields such as `session_key`, `run_id` or other unknown properties. Readers
preserve them, but new native tasks do not create or depend on them.

## Senior binding

`control/senior.json` records the lead host, native session, waiter or watcher identity, delivery state, and takeover history.
Native hosts bind before arming their waiter; Codex also supports legacy thread_id bindings. Old roster tool values
that are absent mean OpenCode; new records explicitly select opencode, claude, or codex. Unknown fields are preserved.

## Task briefs

A brief gives one worker one assignment, one checkout and one write scope. Keep it short enough to scan before work
starts. The task's design history belongs in optional context files; the worker needs the assignment and acceptance
conditions.

```markdown
# T1 — Plain task title
BINDING: the numbered Tasks and Tests below.
OUT OF SCOPE: one nearby thing this task must not do
STOP CONDITION: hand back at needs-review; stop earlier for an Ask first condition
Lock: none
Needs first: none    Size: S    Role: coder

## Owns
| Repo | Worktree | Branch (from base) | Files / dirs |
|---|---|---|---|
| service | worktrees/dp-t1-service | dp/t1-change (origin/target) | src/a.ts, test/a.spec.ts |

## Tasks
1. One checkable action.

## Tests
- `<exact command>`; record its exit code and observed output

## Hand back
- Write REPORT.md, set STATUS to `needs-review`, and stop.

## Ask first if
- a scope, ownership, contract, access or business decision is required
```

`Needs first` expresses dependencies. `Role` is `coder`, `researcher`, `verifier` or `docs`. The configured project
policy determines the Lock binding. Project and pack rules remain authoritative for approval and read-only exemptions.

The `Owns` table is an allowlist for one checkout. Exact files, directories and globs are supported. Two parallel
tasks fail lint when their entries overlap. Ambiguous intersecting glob pairs also fail; replace them with explicit,
disjoint ownership.

New STATUS files contain only `state`, `updated`, `blocker` and `next_action`. The parser continues accepting older
expanded headers. REPORT starts with three result lines, then changed files, exact commands with observed results,
and remaining work or blocker. File hashes are optional unless the brief or workspace rule requires them.

`pack-lint` checks the structural fields, dependencies, secrets, placeholders, one-checkout rule and ownership.
Warnings are planning aids. Fix failures that affect safety or execution; do not add ceremony solely to silence a
stylistic warning.

## Project approval policy

Generic ownership, dependency, checkout and authority checks always apply. `control/config.json` selects an additional
project policy. The default is `"project_policy": { "type": "none" }`; the brief still records `Lock: none`.

New packs record that choice explicitly. Legacy packs without a project_policy field retain the original DDD gate;
adopting a different project policy is an explicit project-owner decision, never a silent migration.

For projects with an existing hash-bound DDD ownership approval, choose `"project_policy": { "type": "ddd" }` or
initialize with `--project-policy ddd`. Coding briefs then bind `.ddd-guard/<slug>/OWNERSHIP-PLAN.md` through an approved
SCOPE-LOCK.txt and its SHA-256 digest. Research, documentation and verification retain their documented exemptions.
The project's own instructions decide when that exemption is appropriate. A bound brief uses
`Lock: .ddd-guard/<slug> digest <64-hex-digest> approved YES`.

A custom gate uses `"project_policy": { "type": "command", "command": ["/absolute/path/to/gate", "check"] }`.
The controller appends `--root <project> --role <role> --lock <brief-lock>` and runs it without a shell, from the project
root. Exit zero allows launch; any other result refuses it. The command is project-controlled and has a 30-second
limit. Task ownership and all other controller gates remain enforced. This hook never grants remote integration authority.
