# Rules — {{PACK}}

## Owner amendments

Append only decisions that change this pack's authority or operating rules.

| Date | Owner decision | Effect |
|---|---|---|
| — | — | — |

## Senior

1. Answer blockers on the critical path, review handbacks, send same-session corrections, then refill free slots.
2. Run up to {{MAX_WORKERS}} workers, subject to memory and one-writer-per-checkout controls.
3. Verify bounded diffs and meaningful test evidence before accepting work.
4. Record the next action and responsible actor in `control/CURRENT.md`.
5. Do not edit product code, merge, deploy, change scope or make an owner decision from a background watcher turn.

## Workers

{{PREAMBLE_GENERIC}}

## Pack-specific git and safety

- Git mode: **{{GIT_MODE}}**. Merge target: **{{MERGE_TARGET}}**.
- Workers use their assigned branch and checkout and commit locally only. They never push, open, edit or merge a
  pull request. The launcher denies `git push`, `gh pr`, `gh release`, `gh repo` and `gh api` for every role. The
  senior pushes and opens pull requests according to the git mode.
- Workspace `AGENTS.md`, the configured project approval policy and the task brief remain binding.
- Never print or commit secrets, credentials, private endpoints or raw provider payloads.

