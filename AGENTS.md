# Contributing to Agent Workpacks

This is a dependency-free Node.js controller and an Agent Skill. Preserve one lead per pack, one writer per
checkout, explicit ownership, durable handbacks, and corrections in the same native session.

Do not change users' authentication or global configuration. Worker CLI adapters own only their generated settings,
processes, and logs. Treat command guards as cooperative controls and check actual ownership at acceptance.

Run `npm run check` and the nearest existing controller checks before a PR. New behavior is proved through the
process-and-file release harness. Record failure scenarios before isolated implementation and keep repeatable run
artifacts. Never add tests that merely mirror generated maps, strings, or implementation structure.

Keep PR notes short and behavioral. Complete review before live provider harness runs. Never publish raw credentials,
user transcripts, or private project evidence. Update the compatibility record only with observed results.

The installable skill lives under `skills/agent-workpacks/`. Runtime helpers stay self-contained there. Contributor
checks and harnesses live under `scripts/`, and existing controller cases and their executable fixture live under
`tests/controller/`. Keep author tooling outside the distributed skill.
