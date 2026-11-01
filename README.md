# Agent Workpacks

Plan, delegate, review, and resume multi-agent engineering work through durable files.

Choose Codex, Claude Code, or OpenCode as the lead, and independently choose any of them for each worker. Workpacks
keep briefs, ownership, saved sessions, questions, reports, and review state on disk. Workers can run in parallel;
a new lead can recover the work from the pack.

## Install

Requires Node.js 24+, Git, and the native CLI for each selected worker. Authenticate the CLI normally before use.
The default OpenCode presets use OpenCode Go; native Claude and Codex use their own existing CLI configuration.

```sh
npx skills add Brymes/agent-workpacks --skill agent-workpacks -a codex -a claude-code -a opencode
```

Add `-g` for all projects. Select just one `-a` target if desired. The skill, scripts, references, and templates travel
together; no separate npm package is needed. See [manual installation and updates](references/installation.md).

| Tool | Start work |
|---|---|
| Codex | `$agent-workpacks plan <goal>` |
| Claude Code | `/agent-workpacks plan <goal>` |
| OpenCode | Ask to use `agent-workpacks` to plan the goal |

## How it works

1. The lead agrees the outcome and writes bounded briefs with disjoint ownership.
2. The controller launches workers in assigned checkouts and records their native session IDs.
3. Workers write questions, progress, and reports. The lead reviews actual changes and acceptance evidence.
4. Corrections resume the same worker session. Monitoring wakes the lead when something needs attention.
5. Another lead can take over from the files, with an explicit change of ownership.

A worker never pushes, opens a PR, merges, deploys, or delegates. Integration remains with the lead under the user's
authority. CLI restrictions and command guards are cooperative controls; acceptance checks the actual diff.

## Commands

From the project, replace `<skill>` with the installed skill directory:

```sh
node <skill>/scripts/pack-worker.mjs doctor --tool opencode
node <skill>/scripts/pack-init.mjs example --root . --pfx EX
node <skill>/scripts/pack-lint.mjs example-pack-v1
node <skill>/scripts/pack-worker.mjs start --pack example-pack-v1 --task EX1 --tool claude
node <skill>/scripts/pack-worker.mjs instruct --pack example-pack-v1 --task EX1 "Review the answer in QUESTIONS.md and continue."
node <skill>/scripts/pack-worker.mjs status --pack example-pack-v1
```

Fill GOAL, PLAN, RULES and the task brief before launching. Follow the [synthetic walkthrough](references/walkthrough.md).
Worker runtime, model, and effort selection are documented in [worker runtimes](references/workers.md).

## Monitoring and recovery

Quiet sweeps make no model calls. Codex uses its queue; Claude and OpenCode use their native background shell
completion notifications around the same waiter. Re-arm a waiter after handling and acknowledging a wake.
[Lead monitoring](references/hosts.md) covers setup, takeover, errors, disabling, and manual recovery.

## Compatibility and verification

Target platforms: macOS and Linux; Windows uses WSL2. The first release targets OpenCode 2. Exact exercised versions,
lead/worker combinations, and evidence classes are recorded in [compatibility](references/compatibility.md).
Adapters being present does not establish that every combination has passed a live run.

```sh
npm run check
npm run test:controller
npm run harness:offline
```

The offline harness retains a run folder and makes no provider requests. Live compatibility runs are explicit and
use an isolated fixture project. [Release acceptance](references/release-acceptance.md) defines the scenarios and order.

## Project policy

New packs default to local commits and generic ownership checks. Projects can enable a hash-bound DDD approval gate
or an argv-based policy command. See [project policy](references/project-policy.md). Installation never changes global
agent configuration or authentication.

MIT licensed. Report reproducible issues through the repository's GitHub issues.
