# Installation

Install Node.js 24+, Git, and the native CLI for the workers you will select. Install the lead tool you will use;
you do not need all three CLIs unless you intend to use all three. Authenticate those tools normally.

```sh
npx skills add Brymes/agent-workpacks --skill agent-workpacks -a codex -a claude-code -a opencode
```

Add `-g` for global installation. The installer copies or links the whole skill directory, including scripts,
references and assets. For one tool, keep only its `-a` argument. Run `npx skills check` and `npx skills update
agent-workpacks` to inspect and install updates. Versioned GitHub releases describe compatibility changes.

## Manual installation

Copy the complete repository directory, including supporting files, to one of these locations:

| Tool | Project | Global |
|---|---|---|
| Codex | `.agents/skills/agent-workpacks/` | `~/.agents/skills/agent-workpacks/` |
| Claude Code | `.claude/skills/agent-workpacks/` | `~/.claude/skills/agent-workpacks/` |
| OpenCode | `.opencode/skills/agent-workpacks/` | `~/.config/opencode/skills/agent-workpacks/` |

OpenCode also discovers `.agents/skills/` and `.claude/skills/`. Avoid duplicate copies with the same name. Restart
or refresh the host's skill discovery when required. The folder and frontmatter name must remain `agent-workpacks`.

Resolve the installed skill path from the host's skill metadata. Run `node <skill>/scripts/pack-worker.mjs doctor
--tool <runtime>` from your project. Override executable discovery only when necessary with OC_BIN, CLAUDE_BIN,
CODEX_BIN, or DP_NODE_BIN. No installer changes global configuration, copies credentials, or launches a provider request.

## Uninstall

Disable monitoring for active packs first. Run `npx skills remove agent-workpacks` (add `-g` for a global install), or
remove the manually copied skill folder. Keep pack folders if their work or evidence is still needed. Uninstalling the
skill never deletes user work or native CLI sessions.

Sources: [installer](https://github.com/vercel-labs/skills), [Codex](https://learn.chatgpt.com/docs/build-skills),
[Claude Code](https://code.claude.com/docs/en/skills), [OpenCode](https://dev.opencode.ai/v2/docs/skills/).
