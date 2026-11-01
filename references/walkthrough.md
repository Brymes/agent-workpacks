# Synthetic walkthrough

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
