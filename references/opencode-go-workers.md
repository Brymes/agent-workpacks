# OpenCode workers

OpenCode is the default worker runtime. Its configured role presets can use OpenCode Go or another provider already
authenticated in OpenCode. See [worker runtimes](workers.md) for selection, permissions and same-session corrections.

OpenCode 2 receives ordered `permissions` rules with `shell` and `subagent` action names. The controller translates
legacy first-match maps into last-match order. No global OpenCode config or credentials are changed. Bundled role
agent definitions are optional; the bounded task preamble remains authoritative when no matching agent is installed.
