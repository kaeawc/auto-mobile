# Live observe App shell (#4682)

`ui://automobile/observe` is the MCP App for `observe`. Owner decision (2026-10-26): it is a
read-only live view, a screenshot with the view-hierarchy boxes, updated through `postMessage`.
It takes no actions and makes no device-control calls; an element picker may come later.

## Who gets what

| Client                                                                                                                                                         | `resources/read ui://automobile/observe`                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Advertises `extensions["io.modelcontextprotocol/ui"]` at `initialize` or in request capabilities (and, when it lists `mimeTypes`, `text/html;profile=mcp-app`) | The stable shell, with `_meta.ui` asking for no network origins and no permissions |
| Anything else, including every client that does not render Apps                                                                                                | The existing session-bound static snapshot, unchanged                              |

The shell is the same bytes for every read, session and device. It holds no observation: the
host delivers each `observe` tool result to the App (`ui/notifications/tool-result`), so the view
always shows the invoking call's result and never a process-global cache or another device's
capture. A result with a hierarchy draws the boxes; if it carries an image content block (observe
with `includeScreenshotImage: true`) the PNG/JPEG/WebP is drawn behind them, otherwise the view says
no screenshot was included. A result that cannot be drawn clears the view instead of leaving the
previous capture up. Capabilities are read from the request declaration when present, falling back to the session's
`initialize` capabilities. The stdio proxy forwards only its advertised UI extension with resource
reads, so the daemon makes the same shell decision as the direct HTTP path.

## Containment

1. **Document CSP.** A `<meta>` policy pins the one inline script and one inline stylesheet by
   SHA-256 and allows `img-src data:` only; `default-src`, `connect-src`, `frame-src`, `object-src`,
   `form-action` and `base-uri` are `'none'`. No `unsafe-inline`, no `unsafe-eval`, no wildcard.
   The hash is computed from the exact script text, including in the minified release build.
2. **Resource `_meta.ui`.** Empty `csp` domain lists and empty `permissions`, so a conforming host
   builds an equally empty policy and grants no camera, microphone, geolocation or clipboard.
3. **Host sandbox (a host requirement).** A `<meta>` cannot set `sandbox` or `frame-ancestors`. The
   host must render the view in a sandboxed iframe with `allow-scripts` only: never
   `allow-same-origin`, `allow-top-navigation`, `allow-popups` or `allow-forms`.
4. **No requests from the App.** Besides replies, the script sends only `ui/initialize`,
   `ui/notifications/initialized` and `ui/notifications/size-changed`. It never sends `tools/call`,
   `resources/read`, `ui/message`, `ui/open-link` or `ui/update-model-context`, and it answers
   any other host request with `-32601`.
5. **Untrusted data.** The script accepts messages only from its parent window, reads results
   defensively (box, node, depth and image-size caps; base64 PNG/JPEG/WebP only, never SVG), and
   writes with `setAttribute`/`textContent` only: no `innerHTML`, `eval`, inline style or
   `document.write`.

`test/server/observeAppShell.test.ts` pins each of these against a fake window and DOM, and
`observeAppShellMinified.integration.test.ts` boots the minified build's script. The security
review of the iframe and CSP setup was done on the first commit; its blocking finding (the boot
call named a function the minifier renames) is fixed.

## Not verified

No live Apps host has rendered this yet (the issue says one is needed): the handshake follows the
2026-01-26 spec's `ui/initialize` / `tool-result` / `resource-teardown` messages as documented, and
needs a pass in Claude Desktop (a local stdio server) or VS Code before the issue can close.
