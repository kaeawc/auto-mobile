# Interactive observe App spike

- Kind: decision
- Date: 2026-11-10
- Source: moved from `how-it-works/mcp/observe-app-interactive.md`; #17767, #17775
- Shaped: [Interactive observe App](../how-it-works/mcp/observe-app-interactive.md)

## Context

A time-boxed spike added an element picker to the live observe App shell behind the
`observe-app-interactive` flag. Measurements were server-side only; no host round trip was
measured.

| Item                       | Bytes  | Gzipped |
| -------------------------- | ------ | ------- |
| Read-only shell document   | 9,321  | 3,213   |
| Interactive shell document | 14,998 | 4,636   |

- Rendering either document took about 0.1 ms; it is the same bytes on every read for a given flag
  value, so a host can cache it.
- The picker adds no server traffic per `observe`. Walking the 50 KB Android home fixture
  hierarchy into 50 targets took about 2.5 ms in Bun.
- The screenshot dominates size. The App shows one only when `observe` ran with
  `includeScreenshotImage: true`, and that image also enters the model's context; this cost
  belongs to the existing shell.

Client support, from public documentation only (no live host rendered either shell):

| Client         | Renders MCP Apps (docs)                  | App-initiated `tools/call` (docs)                   | Live-tested |
| -------------- | ---------------------------------------- | --------------------------------------------------- | ----------- |
| Claude Desktop | Yes, including local stdio servers       | Yes, proxied to the server; may prompt for approval | No          |
| VS Code        | Yes, in chat (GitHub Copilot agent mode) | Yes, proxied to the server                          | No          |

Open questions needing a live host:

1. Does the host deliver `structuredContent` in `ui/notifications/tool-result`?
2. Does the host ask the user before forwarding an App's `tools/call`, and what does the App see
   if the user says no?
3. The model does not learn about a tap made from the App; `ui/update-model-context` could tell
   it, and the spike left this out on purpose.
4. After a tap the view shows the old capture until `observe` runs again; the App could call
   `observe` itself, but the spike kept it to `tapOn`.

## Options

Ship, drop, or iterate.

## Decision

**Iterate**: do not ship yet, and do not drop it. The protocol supports the feature without new
server surface (one flag, a second shell document, no new tool, no change to `observe`) at about
6 KB more document and no extra traffic. Questions 1–3 decide whether the feature is useful or
confusing and can only be answered in a live host, so the flag stays off by default until they are.

## Consequences

If either host fails to deliver structured results or blocks App tool calls, drop the picker and
keep the read-only shell.
