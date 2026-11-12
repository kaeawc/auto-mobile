# iOS WKWebView bridge actions

`AutoMobileWebViewBridge` performs bounded DOM actions on elements from its latest accepted
snapshot. AutoMobile will reach these actions through `observe` and the existing action tools
(#5162); arbitrary JavaScript is never reachable from MCP.

## Action set

| Tool                      | `AutoMobileWebAction` | Script                                                   |
| ------------------------- | --------------------- | -------------------------------------------------------- |
| `tapOn`                   | `click`               | `e.click()`                                              |
| text input                | `setValue`            | focus, set `value`, dispatch `input` then `change`       |
| clear                     | `clear`               | set `value` to `""`, dispatch `input` then `change`      |
| scroll or swipe to target | `scrollIntoView`      | `e.scrollIntoView({block:'center',inline:'center'})`     |
| IME `done`                | `submit`              | `requestSubmit()` on the enclosing form, else `submit()` |

`focus`, `insertText`, `select` and `scroll` remain for host code. Synthetic key events, hover and
navigation are not actions. `evaluateJavaScript` stays a host-only escape hatch, allowed only for
an allowlisted origin, and has no bounded script.

Every element action is checked against the policy first: the snapshot id must name a snapshot the
policy accepted, and the element must be in it, enabled and visible. A stale snapshot or an unknown,
disabled or hidden element is rejected before any script runs.

## Page-controlled ids

Element ids live in the page's `data-automobile-id` attributes, so a page can choose them. An id
never becomes script source: each action script binds it as a JSON string literal and selects the
element with `CSS.escape`, so an id containing quotes, brackets or script text matches nothing
instead of executing. A script whose element is gone does nothing.
