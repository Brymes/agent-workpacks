# Claude lead

Claude uses the shared background waiter. Bind the native Claude session, run the waiter through Bash with
`run_in_background: true`, handle its completion notification, acknowledge handled items, and re-arm.
See [lead monitoring](hosts.md) for commands, exit codes, takeover and recovery.

A nested Claude worker receives a distinct session UUID and no inherited parent-session markers. The worker remains
a bounded assignment and does not become a second lead. Its normal CLI authentication stays in Claude Code.
