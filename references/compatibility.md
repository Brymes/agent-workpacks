# Compatibility

The release target is macOS and Linux with Node.js 24+, OpenCode 2, Claude Code, and Codex. Windows uses WSL2;
native Windows process control is outside this release. Installed versions and acceptance evidence are recorded
here before a release is tagged. A supported adapter is not itself evidence of a live provider run.

| Evidence | Status |
|---|---|
| Historical Codex lead → OpenCode workers | Exercised in private projects; private evidence is not distributed. |
| Historical Claude lead → OpenCode workers | Launch, native background wake and same-session corrections exercised. |
| Historical Claude → Claude | Skill-discovery smoke only; not a complete worker lifecycle. |
| Extracted package controller checks | Pass on macOS; existing ownership, dependency, recovery, probe and waiter cases. |
| Package and skill validation | Pass locally; package checks also pass on the GitHub Linux runner with Node.js 24. |
| Installed CLI capability checks | Pass: OpenCode 2.2.0, Claude Code 2.1.316, Codex CLI 0.166.0. |
| macOS/Linux process harness | Pending release verification. |
| Nine live lead/worker combinations | Pending release verification. |
| Clean installation for three tools | Pending release verification. |

See [release acceptance](release-acceptance.md). Live evidence and simulated process evidence are reported separately.

Release verification is waiting for code review. GitHub accepted Copilot reviewer requests on the public PR, but has
not registered a reviewer or produced a review. The live and platform harnesses have not been run past that gate.
No release tag has been published. Local checks used Node.js 26.12.1; Node.js 24 remains the documented baseline
and is selected explicitly in the Linux/macOS release-harness workflow.
