# Interactive observe App

An element picker on top of the [live observe App shell](observe-app-shell.md) (#17767). Selecting
an element shows its `tapOn` selector, and a button asks the host to run `tapOn` with it. It is
behind the `observe-app-interactive` feature flag, off by default. With the flag off, the `observe`
result and every client's `resources/read ui://automobile/observe` are unchanged.

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
Likewise the observed panel key (`display.key`) goes in as `display`, so on a multi-display device
the tap is routed to the panel the element was picked from and not to the default panel.

A selector only names an element, not one occurrence of it. When two visible elements share a
selector (for example, one Remove button per list row), the panel shows the selector but leaves the
tap button disabled, because `tapOn` would act on the first match and not necessarily the one that
was picked. Every request also sends `selectionStrategy: "unique"`, so the server refuses instead of
guessing if more matches exist than the delivered result showed.

A `{ text }` request also sends `exactText: true`, so `tapOn` does not fall back to a substring
match (a picked "Remove" button that has since gone would otherwise tap a remaining "Remove all").
The tap fails with a message that the element is no longer present and should be re-observed, and
the panel shows that message. The request is:

```json
{
  "jsonrpc": "2.0",
  "id": 1000,
  "method": "tools/call",
  "params": {
    "name": "tapOn",
    "arguments": {
      "selector": { "elementId": "app:id/ok" },
      "selectionStrategy": "unique",
      "deviceId": "emulator-5554",
      "display": "0"
    }
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

## Known gaps

- No live host has rendered either shell; the server side and page script are covered by unit
  tests against a fake window and DOM, including the minified release build.
- Without `structuredContent` in `ui/notifications/tool-result` the view is empty (by design with
  the `tool-results-no-structured-content` flag on).
- The picker shows any JSON-RPC error message the host returns, including a user refusing an App
  `tools/call`.
- The model does not learn about a tap made from the App; its next `observe` sees the new screen
  without a reason. The picker does not send `ui/update-model-context`.
- After a tap the view shows the old capture until `observe` runs again; the App calls only `tapOn`.
- The flag stays off by default until live-host questions are answered.

## Background

- [Interactive observe App spike](../../devlog/2026-11-10-observe-app-interactive-spike.md)
