---
name: agent-workpacks
description: Plan and run delegated engineering work with one lead and persistent workers in Codex, Claude Code, or OpenCode. Use for parallel tasks with bounded ownership, saved worker sessions, file-based handbacks, review, monitoring, and recovery. Do not use for a small single-agent task.
license: MIT
metadata:
  version: "0.1.0"
  modes: "plan dispatch"
  compatibility: "Node.js 24+, Git, selected native CLIs; macOS or Linux"
---

# Agent Workpacks

One lead plans and reviews. Workers execute bounded assignments and hand back through files. The pack is the source
of truth; another lead can recover the work without the previous chat. The lifecycle is plan → launch → handback → review → correction or acceptance. Native CLIs own authentication
and conversation storage; the controller owns assignment, process state, ownership and acceptance.

## Invoke

- Codex: `$agent-workpacks plan <goal>` or `$agent-workpacks dispatch <pack>`.
- Claude Code: `/agent-workpacks plan <goal>` or `/agent-workpacks dispatch <pack>`.
- OpenCode: ask to use `agent-workpacks` to plan the goal or dispatch the existing pack.
- An existing pack path without a mode means dispatch; otherwise plan. Manual `sweep` and `consult` remain compatible.

Resolve this installed skill's directory and run its bundled scripts from the user's project. Do not assume a
particular installation path, project, provider, or model. See [installation](references/installation.md).

## Invariants

- One task has one brief, assigned checkout, write scope, runtime, and saved session. One writer owns a checkout.
- Only `pack-worker.mjs` starts, resumes, or stops workers. Workers do not delegate.
- Workers commit locally only. The lead integrates and performs authorized remote operations.
- Do not change scope, ownership, runtime, or owner-level decisions while correcting a worker. Create a new assignment.
- Project AGENTS.md, RULES.md, and any configured project approval policy remain binding.
- Worker reports are evidence to verify. Check actual diffs, named acceptance behavior, and durable artifacts.
- The lead does not silently become a second product-code writer. Assign separately owned implementation work.
- Default capacity is ten, subject to configured capacity and memory gates. Do not fill slots without useful work.

## Plan

1. Establish the outcome, acceptance, repositories, owner authority, git mode, and useful worker capacity. Reuse answers
   already present in the request or project context.
2. Verify ownership and dependency facts from current source; record unresolved decisions instead of guessing briefs.
3. Initialize with `node <skill>/scripts/pack-init.mjs <slug> --root <project> --pfx <PFX>`. The default git mode is
   commit-only; select remote integration authority explicitly in RULES.md.
4. Split into independent tasks with disjoint checkouts and Owns. Fill each brief from the bundled template. Keep
   briefs runtime-neutral; select the worker runtime when launching. See [brief format](references/pack-format.md#task-briefs).
5. Use meaningful acceptance commands and retained artifacts. Before isolated implementation, record how it can fail.
6. Run `pack-lint.mjs <pack>`, fix safety failures, and record the next action in `control/CURRENT.md`.
7. Bind the lead and arm its monitoring using [lead monitoring](references/hosts.md).

## Dispatch

1. Read RULES.md, PLAN.md, control/CURRENT.md, control/ESCALATIONS.md, and affected task files. Check that this is the
   recorded lead before acting on an automatic wake.
2. Answer critical blockers, review finished reports, send same-session corrections, then start dependency-ready tasks.
3. Launch with `pack-worker.mjs start --pack <pack> --task <ID> --tool opencode|claude|codex`. Model and effort overrides
   are optional. Read [worker runtimes](references/workers.md) for selection and permissions.
4. Correct with `pack-worker.mjs instruct --pack <pack> --task <ID> "<instruction>"`. The saved native session is reused.
   `--fresh` is explicit recovery. A changed brief requires `--accept-brief-change` and unchanged assignment ownership.
5. Verify the bounded diff with `scope`, run the brief's acceptance commands, and record review before marking done.
6. Acknowledge an escalation once actively handled, update CURRENT.md, and re-arm native waiters after each wake.

Fresh failed OpenCode probes block matching new OpenCode launches. Missing or stale probes do not. Native CLI errors
are recorded from real runs; do not substitute providers or change authentication automatically.

## Durable state

The core handoff is GOAL.md, PLAN.md, RULES.md, control/CURRENT.md, control/roster.json, control/ESCALATIONS.md, and each
task's BRIEF.md, STATUS.md, REPORT.md, and QUESTIONS.md. See [pack format](references/pack-format.md).

Monitoring uses the existing no-model sweep. Claude and OpenCode background shell completions wake the originating
session; Codex uses queued delivery. Quiet polling calls no model. See [lead monitoring](references/hosts.md) and
[escalation handling](references/hosts.md#questions-and-escalation). Disable monitoring when work finishes.
