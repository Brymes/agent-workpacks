# Plan — {{PACK}}

Merge target: `origin/{{MERGE_TARGET}}`. Integration branch: <fill: none | int/{{SLUG}}>. Board rows are plan
attributes only; live status is in `control/CURRENT.md`.

## Board

| ID | What you get | Size | Role / model | Needs first | Writes only (repo: files) | Done when |
|---|---|---|---|---|---|---|
| <fill> | <fill> | S | coder / deepseek-v4.1-flash | none | <fill> | <fill> |

## Dependency graph

```
<fill: e.g.  T1 ─┐
             T2 ─┴─► T4 ─► PROOF        (T3 independent)>
```

## Serial links broken

| Former dependency | How it was removed |
|---|---|
| <fill: "T4 needed T2's DTO" | "DTO frozen in CONTEXT ## Contracts; T4 builds against it"> |

## Ownership map (one writer per file)

| Repo | File or dir | Task |
|---|---|---|
| <fill> | <fill> | <fill> |

## Waves and merge order

1. Wave 1: <fill: IDs that start now>
2. Wave 2: <fill>
3. Proof: <fill: the one functional check on merged code>

## Shared-file exceptions

- <fill: none, or "container.ts: T2 only; others request a line via QUESTIONS">
