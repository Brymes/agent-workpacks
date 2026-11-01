# Release acceptance and failure scenarios

Recorded before implementation. This package owns orchestration tooling only. No application service, private skill,
active pack, provider account, or authentication configuration is part of the extraction.

## Failure scenarios

- A clean installation lacks a script, template, executable, required CLI option, or supported Node version.
- A project root, checkout, binary, or pack path contains spaces or differs from the author's machine.
- Project configuration is absent, old, malformed, or contains a project policy that refuses launch.
- A task selects an unknown runtime, switches runtime on resume, or accidentally resumes another task or the lead.
- Authentication, quota, routing, model selection, or permission refusal ends a worker before useful work begins.
- A runtime emits partial JSON, malformed lines, different lifecycle events, no session ID, or exits without a report.
- A stopped worker leaves child processes, locks, or an ambiguous dirty checkout; a correction loses saved context.
- Two tasks share a checkout or overlapping ownership, or a dependent task starts before its prerequisite is accepted.
- A worker changes controller files, writes outside ownership, delegates, or attempts remote GitHub operations.
- A stale failure contaminates a successful attempt, or a failed provider probe incorrectly blocks a different runtime.
- Quiet monitoring invokes a model; a wake is duplicated, lost, acknowledged too soon, or repeatedly delivered.
- Two leads or waiters operate on the same pack; takeover loses unresolved actions or completion leaves monitoring alive.
- Background shell completion never reaches the originating Claude or OpenCode session.
- macOS scheduling, notifications, process control, memory checks, or executable paths break on Linux.
- Installation mutates unrelated agent configuration, requires private context, or distributes credentials or private data.

## Observable proof

The existing offline controller checks must pass. New behavior is proved through process-and-file harness stages,
not post-implementation unit tests. Each run retains commands, exit codes, runtime versions, state transitions and reports.

The synthetic project requires bounded parallel work, a dependent integration task, an in-scope follow-up in the saved
session, and interruption/recovery. It includes predetermined malformed-input, duplicate, ordering and error cases.
Run all nine combinations of lead and worker runtimes; the OpenCode lead uses DeepSeek. Exercise native background
notifications in Claude and OpenCode and queued delivery in Codex. Verify quiet sweeps, acknowledgement, retry and takeover.

Run the portable lifecycle harness on macOS and Linux, and verify installation for every supported tool in a clean
project. A live result and a simulated controller result are separate evidence classes. Do not label unrun combinations
as verified or publish a release while a required acceptance stage remains blocked.

## Release order

Syntax and existing checks, sanitized draft PR, Copilot review (at most three rounds), then release E2E harness on the
latest reviewed head. A behavior fix receives the required follow-up review and reruns the stages it affects.
