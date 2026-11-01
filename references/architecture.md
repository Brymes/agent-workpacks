# Architecture

One lead coordinates a pack. Native worker adapters execute bounded tasks through OpenCode, Claude Code, or Codex.
The filesystem carries every handoff. The lead's chat is useful context; the pack is authoritative.

The controller owns assignment, launch, process and session state, checkout locks, dependencies, ownership validation,
capacity gates, and acceptance. Native CLIs own provider authentication and conversation storage. Workers own only
the brief's tasks and write scope. They do not delegate or perform remote GitHub operations.

The lifecycle is plan → launch → handback → review → correction or acceptance. Corrections reuse the recorded runtime
and session. A new runtime or ownership scope is a new assignment. A fresh session is explicit recovery.

The no-model sweep classifies current attempts and persists escalations. The same waiter serves Claude and OpenCode;
Codex receives a fixed queued prompt. The lead reads authoritative files, handles actions, acknowledges them, and
re-arms monitoring. Delivery does not contain worker-provided text. One recorded lead and one native waiter may be active.

A replacement lead explicitly takes over the binding. Old process/session history remains available and unresolved
work is eligible for delivery to the replacement. No automatic headless lead competes with the recorded session.

Project-specific architecture, production authority, and acceptance policy belong in the project and RULES.md.
