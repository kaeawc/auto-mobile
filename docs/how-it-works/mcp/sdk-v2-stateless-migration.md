# MCP SDK v2 and stateless daemon layer

How the daemon's MCP layer is built on the SDK v2 split packages: a stateless server per request,
one explicit session key, our own request handlers, list-change delivery, and the Tasks and Skills
extensions (epic #4665).

The extensions are on their own page:

- [Tasks and skills extensions](sdk-v2-extensions.md)

## Split packages

The daemon and server use the SDK v2 split packages (`@modelcontextprotocol/server`, `client`,
`node`); see the [split-packages decision record](../../devlog/2026-10-17-mcp-sdk-v2-split-packages.md).
Request handlers are registered by method string; four
v2 behaviour differences are bridged so the wire is unchanged
(`src/daemon/mcpError.ts`, `src/server/sdkMcpServer.ts`,
`src/server/stdioServerTransport.ts`, `src/daemon/socketServer/loopbackMcpClient.ts`);
the test helper is `test/helpers/fakeServerContext.ts`. Tests drive our servers with the
plain v2 `Client`, so client error assertions see the SDK's unprefixed errors; the boundary
checker rejects a v1-error-shape test client.

The stdio transport frames stdin itself (`src/server/stdioRequestFramer.ts`) because the
SDK's read buffer closes the transport on a message over 10 MB (#18330). It admits a
message up to `STDIO_REQUEST_MAX_BYTES` (the 256 MiB HTTP and control-socket cap less
64 KiB of proxy envelope) and answers a larger request with JSON-RPC `-32600` by its
top-level id, discarding the bytes and keeping the session open. When that id cannot
be read (a notification, a batch, an `id` of `null`, or an id that is not a string or
number), no response is sent: the transport reports the request through `onerror`, so a
caller must not wait for a reply.

## Stateless daemon MCP layer

The daemon's HTTP endpoint (`/auto-mobile/streamable`) serves the desktop app's Kotlin client
(`McpHttpClient`) and external clients (#4678):

- Each `POST` builds its own server and transport and closes them when the response
  closes. There is no `transports` map, no idle timer, no per-session in-flight
  counter and no "Session not found" `404`.
- Responses carry no `mcp-session-id`. `GET` and `DELETE` answer `405`.
- A legacy `initialize` followed by `tools/call` works without any session header, and a call
  without `initialize` works. The desktop client echoes `mcp-session-id` only when the server
  returned one.
- Kept: the request admission gate, the DNS-rebinding `allowedHosts` check, SSE keepalive,
  and the session-context headers. Progress notifications travel on the POST's own SSE
  stream.
- Cancellation does not ride on a transport session closing. In-flight requests are
  tracked, and daemon shutdown cancels them with `DaemonHandoffInterruptionError`.
  When a socket disconnects, the socket server cancels that socket session's executions
  directly through `executionTracker`.

- Bun gives no client-disconnect signal, so `notifications/cancelled` is matched in process by
  (session key, request id) and cancels through `executionTracker` (#13049).
- Per-request construction relies on tools being registered once and shared (#13051).

### No restart-404 recovery

With no transport session nothing can expire, so there is no expired-session detection or
replay; tests assert there is none.

## Opt-in modern daemon HTTP routing

`AUTOMOBILE_MCP_MODERN_ERA` defaults off; `1`, `true`, `yes`, or `on` (case-insensitive,
trimmed) enables MCP 2026-07-28 on the daemon HTTP endpoint. Disabled requests use the
existing 2025 serving path without SDK classification or handler construction. When enabled,
`StatelessMcpHttpEndpoint` classifies the already size-limited parsed body: modern requests
use `createMcpHandler` with `legacy: 'reject'` and SSE responses; other outcomes retain the
existing path. The parsed body is passed to the handler so the ingress body limit applies.

The SDK factory reuses `createStatelessMcpServer`, carrying the era and request scope through
an isolated async context. Modern discovery advertises the Tasks extension; legacy initialize
advertisement remains conditional on the client's declaration. Both paths share cancellation
indexing, request-scope execution cancellation, keyless binding cleanup, and shutdown tracking.

Modern HTTP requests validate W3C version `00` trace context from `params._meta` using the
SDK's trace keys. For batches, the first message carrying `_meta` selects the request context.
`mcpTraceContext` installs it inside the detached async root around SDK dispatch, so concurrent
requests stay isolated and work started by a request inherits its context. Invalid traceparents
give no context; malformed tracestate or baggage is dropped independently, with limits of 512
and 8192 characters respectively. Daemon logger wiring reads only the active trace id and adds
`trace=<traceId>` to messages. Private tracestate and baggage values are never added to logs;
requests without a trace and the 2025 path retain their existing log format.

Modern discovery advertises `tools.listChanged`, `resources.listChanged` and `resources.subscribe`. Each endpoint
lazily creates one in-memory event bus on its first modern request and bridges the process-wide
list-change and resource-update broadcasters onto it. All per-request SDK handlers share that bus, so
`subscriptions/listen` can acknowledge and filter tools/resources list changes and resource updates across requests.
Resource-update resolvers receive the union of exact URIs on open listen streams, including page URIs;
the bridge publishes each affected subscribed URI once and the SDK filters delivery per stream.
Tracking is limited to 256 distinct URIs per stream and 4,096 URI memberships across streams
(shared URIs count once per stream). Over-limit streams receive HTTP 429 before acknowledgement,
with one warning per endpoint bridge lifetime; stream closure releases their memberships.
The bridge detaches once admission stops and all requests close, or when the endpoint is cleared.
Listen streams use the same cancellation index, shutdown snapshot, disconnect abort, and
endpoint keepalive as other modern requests; SDK keepalive is disabled. Cache hints remain private,
with a 5s tools-list TTL for clients without a listen stream. The stdio proxy keeps its existing
hand-built server and does not read this flag.

The trace id appears only in logger file/stream records written while the request's own async
context is active; MCP logging notifications, sink-stall records and direct `console` output do not
carry it, and the JSON format embeds it in `message` rather than as its own field.

## Control-socket forwards in process (#11820)

The socket server does not reach the tools over the HTTP endpoint. Each forward gets
its own MCP client and its own stateless server from the factory the endpoint uses
(`src/daemon/statelessMcpServerFactory.ts`: `buildMcpRequestContext` reads the context from
headers or from the forward's struct, `createStatelessMcpServer` builds the server), linked by
an `InMemoryTransport` pair in `InProcessMcpDispatcher` (`src/daemon/inProcessMcpDispatcher.ts`).

A forward keeps the HTTP hop's properties:

- **Wire bytes.** Every message crosses a JSON boundary (`JsonBoundaryTransport`: stringify,
  parse, `parseJSONRPCMessage`), as the streamable HTTP transports do, so `undefined` fields
  drop and shared references break as over HTTP. Errors still pass through
  `LoopbackMcpClient`'s v1 mapping, and an aborted call still rejects with the caller's own
  abort reason.
- **Async context.** The dispatcher enters each server from a root `AsyncResource`
  captured when the daemon builds it, so a handler sees its own request's abort signal, request
  context, tool selection, acquisition receipt and display pin, never the socket handler's.
- **Per-request cancellation.** A forward runs under its own request scope, cancelled before
  its server closes. Because the pair is private to the forward, an aborted call's
  `notifications/cancelled` reaches the server that is running it, which the stateless HTTP
  endpoint could only approximate (#13067).
- **Shutdown.** With no `503`, the dispatcher is the admission gate: shutdown stops it
  accepting forwards when it quiesces ingress, and closes running forwards with
  `DaemonHandoffInterruptionError` beside the HTTP requests.

`test/daemon/mcpForwardByteParity.integration.test.ts` pins this: the same socket frames go
through an MCP client over the real HTTP endpoint and through the dispatcher, and the socket
lines must be byte-identical (results, tool and protocol errors, lists, progress, socket
cancel, every refusal fixture), with a context-leak probe that also shows an unrooted pair
would leak.

There is no device-control transport recovery (reconnect, pin, replay). The
`device_control_transport_failure` wire type stays because the proxy and the daemon client still
read it from older daemons. A per-execution-key idle timer exists only to drop the cached Android
append helper.

The HTTP endpoint serves only the desktop app and external clients. It keeps the
admission gate, DNS-rebinding protection, SSE keepalive, session-context headers and its
`notifications/cancelled` resolution, which also matches a header-less cancellation by
request id when exactly one in-flight request has it.

## The one session key

`src/daemon/mcpSessionKey.ts` exports `MCP_SESSION_KEY_HEADER`
(`x-auto-mobile-mcp-session-id`) and `readMcpSessionKey(headers)`. This is the only key for
per-session tool binding and `tools/list` filtering in daemon mode.

- The socket server keys every forward's server on the socket session id.
- The desktop client generates one id per app session and sends it in the same header on
  every call.
- Precedence (#13315): the header wins. The exception is the daemon's own
  in-process forward (`InProcessMcpDispatcher`, which marks its request scope
  `trustedForwarder` and builds the server with `trustForwardedMcpSessionId`): the in-band
  `__mcpSessionId` the socket server injects names the originating client, so it outranks the
  forward's connection key. An in-band id from any other source, such as a plain HTTP client
  putting `__mcpSessionId` in the tool arguments beside a header, never overrides the header.
  A direct HTTP request with no header still falls back to its in-band id, so header-less
  clients keep working. `parseCallContext` is the single place this is resolved.
- The in-band `__mcpSessionId` argument is still accepted and stripped from tool
  arguments before schema validation (`stripInternalToolParams`). On a direct request it is a
  fallback carrier for the same explicit key.
- An explicit `sessionUuid` argument still wins where a tool takes one.
- `tools/list` has no arguments, so the header is what lets an argument-less list be
  filtered per session.
- Direct stdio keeps its single "direct" slot.

Because every per-request server creates its own `SessionToolBinding`, the binding maps
live in a daemon-scoped `SessionToolBindingStore` that outlives any one server. Release
teardown subscribes once on the store rather than once per server, and a release clears a
binding exactly once. The cross-routing refusal
(`SessionOutsideBoundSessionError`), the #7005 profile exception, the #11602 plan-label
equivalence and the `__*` stripping still apply. The question of whether in-band `__*` keys propagate
into nested calls is separate and unsettled (#11823).

See [Device ownership](../../using/device-ownership.md) for what the key means to a caller.

## Handlers stay ours

`tools/list`, `tools/call` and resource handlers stay registered by method string on the
low-level server, not through the SDK's `registerTool` dispatch. The wire stays byte-identical
for external clients and the desktop app; the wire-parity and `schemas/tool-definitions.json`
drift checks pin it.

## list_changed: internal push plus polling fallback

A per-request server cannot hold a notification channel, so list-changed delivery does not
depend on one:

- Per-request servers are registered with `ephemeral: true`, tracked only until they close,
  and `notifyToolListChanged` does not send to them.
- The internal push: `ListChangedBroadcaster` to the socket server's
  `notificationSubscribers` to `DaemonMcpProxy.onListChanged`, which makes the proxy emit
  `list_changed` to its own client.
- The proxy adds a fallback (`ToolListPoller`): if the subscription is not acknowledged or
  drops, it polls `tools/list` and `resources/list` on a slow interval, compares a hash and
  re-emits `list_changed` only when the hash changes. A push and a poll arriving together
  must not produce two emits.
- Opt-in modern daemon HTTP clients receive list changes on the shared endpoint bus (above);
  `subscriptions/listen` support across hosts is unverified.

## Non-goals

- Taskifying short synchronous interaction tools (`tapOn`, `inputText`, `pressButton`).
- A serverless/edge redeployment: AutoMobile binds to local ADB/simctl and is stateful on its
  host; the stateless _protocol_ is served over a factory, but device state stays on the daemon.

## Background

- [MCP SDK v2 and stateless daemon migration](../../devlog/2026-07-29-sdk-v2-stateless-migration-decisions.md)
- [MCP SDK v2 adoption survey](../../devlog/2026-10-27-sdk-v2-adoption-survey-proposals.md)
- [MCP TypeScript SDK v2 split packages](../../devlog/2026-10-17-mcp-sdk-v2-split-packages.md)
