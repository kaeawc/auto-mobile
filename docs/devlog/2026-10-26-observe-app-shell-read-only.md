# Read-only live observe App shell

- Kind: decision
- Date: 2026-10-26
- Source: moved from `how-it-works/mcp/observe-app-shell.md`; #4682, #15512
- Shaped: [Live observe App shell](../how-it-works/mcp/observe-app-shell.md)

## Context

`ui://automobile/observe` needed a shape as an MCP App for clients that advertise MCP Apps (#4682).

## Options

Not recorded.

## Decision

Owner decision (2026-10-26): the App is a read-only live view, a screenshot with the
view-hierarchy boxes, updated through `postMessage`. It takes no actions and makes no
device-control calls.

## Consequences

- A tapping element picker came later as a separate flag-gated spike (the interactive observe App).
- The security review of the iframe and CSP setup ran on the first commit; its blocking finding
  (the boot call named a function the minifier renames) was fixed.
- #4682 needs a live Apps host pass (Claude Desktop with a local stdio server, or VS Code) before
  it can close.
