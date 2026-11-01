# Compact task brief

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

`Needs first` expresses dependencies. `Role` is `coder`, `researcher`, `verifier` or `docs`. Service-code tasks carry
the approved DDD lock required by the workspace. Research, documentation and truly read-only verification may use a
`Lock: none (...)` exemption only when workspace and pack rules allow it.

The `Owns` table is an allowlist for one checkout. Exact files, directories and globs are supported. Two parallel
tasks fail lint when their entries overlap. Ambiguous intersecting glob pairs also fail; replace them with explicit,
disjoint ownership.

New STATUS files contain only `state`, `updated`, `blocker` and `next_action`. The parser continues accepting older
expanded headers. REPORT starts with three result lines, then changed files, exact commands with observed results,
and remaining work or blocker. File hashes are optional unless the brief or workspace rule requires them.

`pack-lint` checks the structural fields, dependencies, secrets, placeholders, one-checkout rule and ownership.
Warnings are planning aids. Fix failures that affect safety or execution; do not add ceremony solely to silence a
stylistic warning.
