# {{PACK}} — start here

Created {{DATE}} with the agent-workpacks skill. Workspace root: `{{ROOT}}`.

## Outcome

1. <what this pack delivers>
2. <what the workers own>
3. <what proves completion>

## Read order

- Owner: `control/CURRENT.md`, then `GOAL.md`.
- Senior: `RULES.md`, `PLAN.md`, `control/CURRENT.md`, `control/ESCALATIONS.md`, then affected tasks.
- Worker: workspace `AGENTS.md`, `RULES.md`, its `BRIEF.md`, `QUESTIONS.md` and `INBOX.md`.

The configured project approval policy and each brief's Owns determine what may change. Current source beats stale prose. Record
a real policy exception as a dated owner amendment in RULES.md; otherwise stop on a conflict.

## Controller commands

From `{{ROOT}}`:

```bash
{{NODE}} {{SKILL_DIR}}/scripts/pack-worker.mjs start --pack {{ROOT}}/{{PACK}} --task <ID>
{{NODE}} {{SKILL_DIR}}/scripts/pack-worker.mjs instruct --pack {{ROOT}}/{{PACK}} --task <ID> "re-read QUESTIONS.md and continue from next_action"
{{NODE}} {{SKILL_DIR}}/scripts/pack-worker.mjs status --pack {{ROOT}}/{{PACK}}
{{NODE}} {{SKILL_DIR}}/scripts/pack-watch.mjs attach --pack {{ROOT}}/{{PACK}}
```

`attach` is for a Codex senior. Its watcher runs a no-model sweep every 15 minutes and queues new action into this
pack's recorded Codex senior. The optional 30-minute Codex heartbeat is a fallback and consumes a subscription turn
even when quiet.

A Claude or OpenCode lead binds its native session before arming the waiter. It runs this waiter with the Bash tool's `run_in_background`, never
`nohup … &`, and re-arms it after each wake (`{{SKILL_DIR}}/references/claude-senior.md`):

```bash
{{NODE}} {{SKILL_DIR}}/scripts/pack-watch.mjs wait --pack {{ROOT}}/{{PACK}} --also-watch {{ROOT}}/{{PACK}}/control/lane-results.jsonl
```

Fresh senior resume prompt:

> Run $agent-workpacks dispatch {{ROOT}}/{{PACK}}. Treat the pack files as authoritative. Review or correct finished
> workers, answer file-based questions, refill ready slots, and update control/CURRENT.md. Do not edit product code,
> merge, deploy or change scope.

## State

Owner summary: `control/CURRENT.md` · runtime/session state: `control/roster.json` · watcher binding:
`control/senior.json` · task handoffs: `tasks/<ID>/`.

