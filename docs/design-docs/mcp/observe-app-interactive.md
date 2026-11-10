# Interactive observe App (spike, #17767)

A time-boxed spike: an element picker on top of the [live observe App shell](observe-app-shell.md).
Selecting an element shows its `tapOn` selector, and a button asks the host to run `tapOn` with it.
It is behind the `observe-app-interactive` feature flag, off by default. With the flag off, nothing
changes: the `observe` result and every client's `resources/read ui://automobile/observe` stay as
they were.

## Who gets what

| Flag | Client advertises MCP Apps | `resources/read ui://automobile/observe`                   |
| ---- | -------------------------- | ---------------------------------------------------------- |
| off  | yes                        | The read-only shell                                        |
| on   | yes                        | The interactive shell: the read-only shell plus the picker |
| any  | no                         | The session-bound static snapshot, as before               |

The flag is read on every resource read, so a toggle applies to the next read. A host that cached
the resource earlier (some hosts prefetch the template at `tools/list`) keeps its old copy until it
reads again.

## Protocol pieces used

All from the MCP Apps spec (2026-01-26), the same version the read-only shell uses:

- `ui/initialize`, `ui/notifications/initialized`, `ui/notifications/size-changed`,
  `ui/notifications/host-context-changed` and `ui/resource-teardown`: the shell's handshake, unchanged.
- `ui/notifications/tool-result`: the host delivers each `observe` result. The shell draws it, then
  the picker draws one transparent hit target per element that has a selector, smallest on top, so
  a click picks the innermost element.
- `tools/call` from the App to the host, `name: "tapOn"`. This is the only request the picker adds.
  The host decides whether to forward it to the server and whether to ask the user first. `tapOn`
  has no `_meta.ui.visibility`, so the spec default (`["model", "app"]`) lets an App call it.

## Selector and payload

The selector is the element's `resource-id` as `{ elementId }`, or else its text or content
description as `{ text }` (the `text` selector matches both). An element with neither is drawn but
cannot be picked. When the delivered result carries a `deviceId`, it goes into the arguments, so
the tap goes to the device that was observed and not to whatever device is active at that moment.
The request is:

```json
{
  "jsonrpc": "2.0",
  "id": 1000,
  "method": "tools/call",
  "params": {
    "name": "tapOn",
    "arguments": { "selector": { "elementId": "app:id/ok" }, "deviceId": "emulator-5554" }
  }
}
```

Unit tests parse those arguments with the real `tapOnSchema`, so the payload cannot drift from the
tool contract.

## Containment

The read-only shell's layers all still apply: a hashed-inline-only CSP with `connect-src 'none'`,
empty `_meta.ui` CSP domains and permissions, `allow-scripts`-only sandboxing by the host, untrusted
data checks, and DOM writes through `textContent`/`setAttribute` only. Compared with the read-only
shell, the picker:

- sends `tools/call` only after a click on its tap button, never because a result arrived;
- can name only `tapOn` (a test checks the script for any other tool name);
- sends no `resources/read`, `ui/message`, `ui/open-link` or `ui/update-model-context`;
- accepts replies only from its parent window, and only for request ids it sent.

## Size and latency

These are measured on the server side only; no host round trip was measured.

| Item                       | Bytes  | Gzipped |
| -------------------------- | ------ | ------- |
| Read-only shell document   | 9,253  | 3,203   |
| Interactive shell document | 14,329 | 4,425   |

- Rendering either document takes about 0.1 ms. It is the same bytes on every read for a given
  flag value, so a host can cache it.
- The picker adds no server traffic per `observe`. It reads the result the host already delivers.
  Walking the 50 KB Android home fixture hierarchy into 50 targets takes about 2.5 ms in Bun.
- The screenshot dominates the size. The App only shows one when `observe` ran with
  `includeScreenshotImage: true`, and that image block also goes into the model's context. This
  cost belongs to the existing shell and the spike does not change it.

## Per-client findings

Neither client could run in the cloud environment where the spike was built. **Every client claim
below comes from public documentation and has not been tested.** What was tested is the server
side and the page script, run against a fake window and DOM, including the minified release build.

| Client         | Renders MCP Apps (docs)                  | App-initiated `tools/call` (docs)                   | Verified here |
| -------------- | ---------------------------------------- | --------------------------------------------------- | ------------- |
| Claude Desktop | Yes, including local stdio servers       | Yes, proxied to the server; may prompt for approval | No            |
| VS Code        | Yes, in chat (GitHub Copilot agent mode) | Yes, proxied to the server                          | No            |

Open questions that need a live host:

1. Does the host deliver `structuredContent` in `ui/notifications/tool-result`? The view needs it.
   With the `tool-results-no-structured-content` flag on, the view is empty by design.
2. Does the host ask the user before it forwards an App's `tools/call`, and what does the App see
   if the user says no? The picker shows any JSON-RPC error message it gets back.
3. The model does not learn about a tap made from the App. Its next `observe` sees the new screen,
   but it has no record of why the screen changed. `ui/update-model-context` could tell it; the
   spike leaves this out on purpose.
4. After a tap the view still shows the old capture until `observe` runs again. The App could call
   `observe` itself, but the spike keeps it to `tapOn`.

## Recommendation: iterate

Don't ship it yet, and don't drop it.

The protocol supports the feature without new server surface: one flag, a second shell document,
no new tool and no change to `observe`. The cost is small: about 5 KB more for the document and no
extra traffic. But no live host has rendered either shell yet, and questions 1–3 decide whether the
feature is useful or confusing.

The next iteration:

1. Run both shells in Claude Desktop and VS Code against a local server.
2. Settle how the model hears about a tap made from the App (question 3).
3. Only then decide whether to turn the flag on by default.

If either host fails to deliver structured results or blocks App tool calls, drop the picker and
keep the read-only shell.
