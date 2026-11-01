# Worker runtimes

Select a runtime with `pack-worker.mjs start --pack <pack> --task <ID> --tool opencode|claude|codex`.
The default is OpenCode. Runtime choice is independent of the lead tool; an OpenCode lead using DeepSeek can launch
Claude or Codex workers through this command. Workers themselves do not delegate.

| Runtime | First turn | Follow-up | Authentication |
|---|---|---|---|
| OpenCode | `opencode run --format json` | saved `--session` | existing OpenCode login |
| Claude Code | print mode with stream JSON and a distinct session UUID | explicit `--resume` | existing Claude Code login |
| Codex | `codex exec --json` | `codex exec resume` with the saved ID | existing Codex login |

`--model` overrides the chosen runtime's model. `--variant` maps to OpenCode's model variant, Claude's effort, or
Codex's reasoning effort. Native Claude/Codex otherwise inherit the CLI model; no provider credentials are copied.
Configure native defaults under `runtime_defaults.claude` or `.codex` with `model` and `variant`. OpenCode role presets
remain under `models`: coder/verifier use DeepSeek and researcher/docs use GLM, and can be changed per project.

Corrections use `instruct`, which retains the runtime and native session. If no session was recorded, inspect the
failed attempt before using explicit `--fresh`. An interrupted attempt retains logs and dirty work for recovery.
`--accept-brief-change` accepts a revised task description only when ownership and the rest of the assignment remain
unchanged. Stop a running worker before accepting that revision.

Every runtime gets the same bounded preamble, local-only Git rule, and command wrappers that deny common remote
operations. OpenCode receives its native version-specific permission format; Claude receives task-scoped settings;
Codex uses workspace-write permissions with its task output directory added. These are cooperative guardrails,
not equivalent OS isolation. Check actual ownership with `scope` before accepting work.

The optional OpenCode SQLite liveness peek is best-effort and can be disabled with `DP_NO_DB=1`. Versioned JSON
streams and current-attempt process state are the primary evidence. `pack-probe.mjs` is an optional OpenCode provider
diagnostic; it is not required for native workers or same-session corrections.
