# Live preview server uses node:http and SSE, not Vite

- Kind: decision
- Date: 2026-11-11
- Source: moved from `how-it-works/prototype-web-preview-server.md`; #18007
- Shaped: [Prototype live preview server](../how-it-works/prototype-web-preview-server.md)

## Context

The `prototype` tool's `serve` action shows a prototype's web page in a browser and reloads it on
each `show` and landed `patch`, within one second.

## Options

- Vite dev server with HMR.
- `Bun.serve`.
- A WebSocket for reload messages.
- node:http with server-sent events.

## Decision

node:http with server-sent events for reload.

## Consequences

- The page is already one self-contained HTML document rendered by the host; there is no module
  graph to bundle or hot-swap, so a dev server's HMR has nothing to do.
- SSE meets the one-second reload target with node:http, which Bun implements and
  `daemonHttpIngress` already uses.
- A WebSocket would add a dependency (`ws`) for one-way messages.
- `Bun.serve` would also work but ties the server to Bun's API, where the daemon's other HTTP
  servers use node:http.
