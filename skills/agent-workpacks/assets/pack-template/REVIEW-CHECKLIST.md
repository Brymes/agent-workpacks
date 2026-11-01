# Review checklist — {{PACK}}

Use this for a `needs-review` handback.

1. Run `pack-worker scope --pack <pack> --task <ID>` and confirm every changed file is inside Owns.
2. If the brief names a ddd-guard lock, verify that the implementation stayed inside the approved ownership plan.
3. Read the bounded diff and check the brief's tasks and stop conditions.
4. Re-run the meaningful tests needed to assess the worker's reported result.
5. Confirm REPORT has a three-line summary, changed files, observed commands/results and remaining work.
6. Record `pass` or `changes`. For changes, write a precise item in QUESTIONS.md and resume the same worker session.

Do not turn style preferences into review rounds. Do not merge, deploy or widen scope from a watcher-triggered senior
turn.
