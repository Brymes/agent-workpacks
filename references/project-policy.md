# Project approval policy

Generic ownership, dependency, checkout and authority checks always apply. `control/config.json` selects an additional
project policy. The default is `"project_policy": { "type": "none" }`; the brief still records `Lock: none`.

For projects with an existing hash-bound DDD ownership approval, choose `"project_policy": { "type": "ddd" }` or
initialize with `--project-policy ddd`. Coding briefs then bind `.ddd-guard/<slug>/OWNERSHIP-PLAN.md` through an approved
SCOPE-LOCK.txt and its SHA-256 digest. Research, documentation and verification retain their documented exemptions.
The project's own instructions decide when that exemption is appropriate.

A custom gate uses `"project_policy": { "type": "command", "command": ["/absolute/path/to/gate", "check"] }`.
The controller appends `--root <project> --role <role> --lock <brief-lock>` and runs it without a shell, from the project
root. Exit zero allows launch; any other result refuses it. The command is project-controlled and has a 30-second
limit. Task ownership and all other controller gates remain enforced. This hook never grants remote integration authority.
