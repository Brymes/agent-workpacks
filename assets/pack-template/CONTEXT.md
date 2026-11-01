# Context — {{PACK}}

Verified at {{DATE}} against `origin/{{MERGE_TARGET}}` by the planner. Git beats this file: if they disagree, trust
git, fix this file, log it in `LEDGER.md` §2.

## Repositories and bases

| Repo | Path | Base ref @ sha | Worktrees for this pack |
|---|---|---|---|
| <fill> | `{{ROOT}}/<repo>` | `origin/{{MERGE_TARGET}}@<sha>` | `worktrees/{{PFX_LOWER}}-<id>-<repo>` |

## Who owns what

<fill: service ownership lines relevant to this pack (from `.agents/skills/ddd-guard/rules/service-ownership.md`)>

## Code pointers (file:line, verified)

- <fill>

## Fixed names (config keys, events, queues, routes)

- <fill>

## Contracts (orchestrator-only; lanes request changes via QUESTIONS)

| # | Contract | Shape | Consumers | Frozen at |
|---|---|---|---|---|
| C1 | <fill> | <fill> | <fill> | {{DATE}} |
