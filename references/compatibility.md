# Compatibility

The release target is macOS and Linux with Node.js 24+, OpenCode 2, Claude Code, and Codex. Windows uses WSL2;
native Windows process control is outside this release. Installed versions and acceptance evidence are recorded
here before a release is tagged. A supported adapter is not itself evidence of a live provider run.

| Evidence | Status |
|---|---|
| Historical Codex lead → OpenCode workers | Exercised in private projects; private evidence is not distributed. |
| Historical Claude lead → OpenCode workers | Launch, native background wake and same-session corrections exercised. |
| Historical Claude → Claude | Skill-discovery smoke only; not a complete worker lifecycle. |
| Extracted package controller checks | Pending release verification. |
| macOS/Linux process harness | Pending release verification. |
| Nine live lead/worker combinations | Pending release verification. |
| Clean installation for three tools | Pending release verification. |

See [release acceptance](release-acceptance.md). Live evidence and simulated process evidence are reported separately.
