# Questions and escalation

Workers communicate through `QUESTIONS.md`; the deterministic sweep renders open work into
`control/ESCALATIONS.md`. The recorded lead handles in-scope engineering questions, routine review and worker
corrections. The owner handles scope, business, credential, merge and deployment decisions.

## Question format

```markdown
## Q-<PFX>-<ID>-NNN <short title> [senior|owner|orchestrator]
- Why it matters: ...
- Options: ...
- Recommendation: ...
- Blocks: ...

**A (senior, <HH:MM>):** ...
```

Allocate IDs with `pack-next-id.mjs`. Never rewrite an answered question; add another question when new evidence
changes the issue.

## Senior procedure

1. Read the escalation packet, BRIEF, STATUS, REPORT and QUESTIONS. Read other pack context or bounded source only
   when needed.
2. Answer decisions already established by GOAL, PLAN, RULES and the approved brief.
3. If the answer would change scope, ownership, a contract or an owner-level decision, record the request in
   CURRENT.md and stop that path.
4. Write the answer under the question, then use `pack-worker instruct` so the saved native session continues.
5. Acknowledge the sweep item while it is being handled. The next sweep resolves it when the underlying condition
   clears.

The senior does not edit product code, merge, deploy, or launch another senior controller from a watcher-triggered
turn. If the assignment itself is wrong, create a new validated assignment; do not silently rewrite ownership.
