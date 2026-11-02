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
together; no separate npm package is needed. See [manual installation and updates](skills/agent-workpacks/references/installation.md).

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

Fill GOAL, PLAN, RULES and the task brief before launching. Follow the [synthetic walkthrough](#synthetic-walkthrough).
Worker runtime, model, and effort selection are documented in [worker runtimes](skills/agent-workpacks/references/workers.md).

## Monitoring and recovery

Quiet sweeps make no model calls. Codex uses its queue; Claude and OpenCode use their native background shell
completion notifications around the same waiter. Re-arm a waiter after handling and acknowledging a wake.
[Lead monitoring](skills/agent-workpacks/references/hosts.md) covers setup, takeover, errors, disabling, and manual recovery.

## Compatibility and verification

Target platforms: macOS and Linux; Windows uses WSL2. The first release targets OpenCode 2. Exact exercised versions,
lead/worker combinations, and evidence classes are recorded in [compatibility record](#compatibility-record).
Adapters being present does not establish that every combination has passed a live run.

```sh
npm run check
npm run test:controller
npm run harness:offline
```

The offline harness retains a run folder and makes no provider requests. Live compatibility runs are explicit and
use an isolated fixture project. [Release acceptance](docs/release-acceptance.md) defines the scenarios and order.

## Project policy

New packs default to local commits and generic ownership checks. Projects can enable a hash-bound DDD approval gate
or an argv-based policy command. See [project policy](skills/agent-workpacks/references/pack-format.md#project-approval-policy). Installation never changes global
agent configuration or authentication.

MIT licensed. Report reproducible issues through the repository's GitHub issues.

## Synthetic walkthrough

Use an isolated Git repository with a small JSON import utility. The predetermined acceptance cases include blank
lines, malformed records, duplicate IDs, mixed ordering, and an exact summary. Keep the fixtures and expected output
outside the worker's write scope. No accounts, production data, or external services are needed for the fixture logic.

1. Initialize `example-pack-v1` from the project with prefix EX. Fill its GOAL, PLAN and RULES, choosing the lead and
   integration authority. Document failure scenarios and the acceptance command before implementation.
2. Give EX1 the parser and EX2 the validator, using separate branches/checkouts and disjoint ownership. Give EX3 the
   summary/integration, with `Needs first: EX1 EX2`. Each task has a short brief and a retained output artifact.
3. Bind and monitor the lead. Launch EX1 with `--tool claude` and EX2 with `--tool codex`; select explicit models only
   if needed. Inspect reports and actual diffs, answer questions, and accept prerequisites before starting EX3.
4. Launch EX3 with `--tool opencode`. Follow up with an approved in-scope output requirement; verify its recorded
   session is reused and the resulting behavior matches the independent expected output.
5. Interrupt and resume a worker, retaining its surviving work. Explicitly transfer the lead if recovery is part of
   the exercise. Complete the pack only after the integration acceptance passes, then disable monitoring.

The release harness automates lifecycle evidence; this walkthrough explains how to apply the same structure to real
engineering work. Keep fixture-only controls out of product tasks.

## Compatibility record

The release target is macOS and Linux with Node.js 24+, OpenCode 2, Claude Code, and Codex. Windows uses WSL2;
native Windows process control is outside this release. Installed versions and acceptance evidence are recorded
here before a release is tagged. A supported adapter is not itself evidence of a live provider run.

| Evidence | Status |
|---|---|
| Historical Codex lead → OpenCode workers | Exercised in private projects; private evidence is not distributed. |
| Historical Claude lead → OpenCode workers | Launch, native background wake and same-session corrections exercised. |
| Historical Claude → Claude | Skill-discovery smoke only; not a complete worker lifecycle. |
| Extracted package controller checks | Pass on macOS; existing ownership, dependency, recovery, probe and waiter cases. |
| Package and skill validation | Pass locally; package checks also pass on the GitHub Linux runner with Node.js 24. |
| Installed CLI capability checks | Pass: OpenCode 2.2.0, Claude Code 2.1.316, Codex CLI 0.166.0. |
| macOS/Linux process harness | Pending release verification. |
| Nine live lead/worker combinations | Pending release verification. |
| Clean installation for three tools | Pending release verification. |

See [release acceptance](docs/release-acceptance.md). Live evidence and simulated process evidence are reported separately.

Release verification is waiting for code review. GitHub accepted Copilot reviewer requests on the public PR, but has
not registered a reviewer or produced a review. The live and platform harnesses have not been run past that gate.
No release tag has been published. Local checks used Node.js 26.12.1; Node.js 24 remains the documented baseline
and is selected explicitly in the Linux/macOS release-harness workflow.

## Repository layout

`skills/agent-workpacks/` is the installable package. It contains the runtime, templates, four references and its
licence. Contributor checks and release harnesses stay in `scripts/`, controller verification stays in `tests/`,
and release acceptance stays in `docs/`. All 18 pack templates are retained.

From a source checkout, use `skills/agent-workpacks` as the `<skill>` path in the commands above. The installation
command and installed runtime command names are unchanged.
