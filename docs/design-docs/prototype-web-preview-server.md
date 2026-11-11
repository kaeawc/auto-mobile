# Prototype live preview server

The `prototype` tool's `serve` and `stop` actions run a small HTTP server that shows a prototype's
web page in a browser and reloads it on each `show` and landed `patch`.

## Components

- `PrototypePreviewPageSource` is the only thing the server reads: prototype ids, an id's related
  ids (its variant group), the page HTML, and a change signal. The default source wraps the spec
  revisions the `automobile:prototype/<id>/web` resource reads, so the served page is that resource's
  HTML, byte for byte, and a change is a recorded revision (or an eviction).
- `PrototypePreviewServer` owns the lifecycle: bind, stop, idle timeout, and the event streams. Its
  socket goes through `PreviewHttpBinder` (node:http in production, an in-process fake in unit
  tests) and its timers through the injected `Timer`.
- `daemonPrototypePreview.ts` holds the daemon's one server, so the daemon's shutdown stage
  `prototype preview server` stops it without loading the prototype runtime.

## Routes

| Path             | Content                                                                        |
| ---------------- | ------------------------------------------------------------------------------ |
| `/`              | Index of ids with web output                                                   |
| `/p/<id>`        | Shell: the page in an iframe plus the reload script                            |
| `/p/<id>/page`   | The web resource HTML; `frame` and `variant` query parameters pass through     |
| `/p/<id>/events` | Server-sent events: `ready {generation}` on connect, `reload {id, generation}` |

The web page's CSP allows only its own runtime script and no network, so the page is never
modified. The reload script lives in the shell, whose CSP pins that script's hash and allows
`connect-src 'self'` and `frame-src 'self'`. The shell renders the iframe without `src` and loads
it on the first `ready` (or on a stream error before one), so the page is requested only after the
stream is subscribed and a change between the two cannot go unseen. On `reload` the shell reads the variant picked in the
same-origin iframe and reloads the iframe with it. `generation` counts changes: a later `ready` with a
different generation means a change was missed, and the shell reloads.

A page for `P` gets `reload` when the changed id is `P`, is in `P`'s variant group now, or was at
the previous change, so a variant that leaves the group still reloads its pages once.

## Invariants

- One server per daemon. `serve`, `stop` and the idle stop are serialized, so concurrent calls from
  several MCP connections never leave two sockets bound. `serve` while running keeps the server
  unless `port` or `remote` differ.
- A loopback server answers only `Host` values `127.0.0.1:<port>`, `localhost:<port>` and
  `[::1]:<port>` (421 otherwise), which refuses DNS rebinding. `remote: true` binds `0.0.0.0` and
  skips the check.
- Idle means no open event stream and no request or change for `idleTimeoutMs`; an open tab keeps
  the server alive. A 15 s SSE comment keeps open streams from idling out of intermediaries.
- Stop ends every event stream before closing the listener (`closeAllConnections`), so the port is
  free when the call returns.

## Why no Vite

The page is already one self-contained HTML document rendered by the host; there is no module
graph to bundle or hot-swap, so a dev server's HMR has nothing to do. Reload over SSE meets the
one-second acceptance with node:http (Bun implements it, as `daemonHttpIngress` already uses), and
a WebSocket would add a dependency (`ws`) for one-way messages. `Bun.serve` would also work but
binds the server to Bun's API where the daemon's other HTTP servers use node:http.

## Headless mode

Headless mode (#17974) plugs in through `PrototypePreviewPageSource`: if it records its shown specs
into the daemon's spec revisions, the default source serves them unchanged; otherwise it supplies
its own source through `PrototypeToolDependencies.preview`.
