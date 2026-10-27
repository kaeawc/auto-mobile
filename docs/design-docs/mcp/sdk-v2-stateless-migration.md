# MCP SDK v2 and stateless daemon layer: decision record

Status: **landed (#4678)**, epic [#4665](https://github.com/kaeawc/auto-mobile/issues/4665).
Step 1 (SDK v2 split packages), the stateless daemon layer (slices A to K) and slice L
(control-socket forwards in process, #11820) are on main.

This record began as the feasibility spike for #4666 (condensed at the end as the
[original spike assessment](#appendix-original-spike-assessment-2026-07-29)). The
spike's go/no-go has since been replaced by owner decisions, summarised here.

## Decisions

| #   | Decision                                                                                                                                                                                                                              | Status                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | Adopt the SDK v2 split packages (`@modelcontextprotocol/server` and `client` 2.3.1, `@modelcontextprotocol/node` 2.1.1). See [MCP TypeScript SDK v2 split packages](../../decisions/mcp-sdk-v2-split-packages.md); not repeated here. | Landed (step 1)                 |
| 2   | The daemon's internal MCP layer is stateless: a server and transport per request, no `mcp-session-id`, no transport session map.                                                                                                      | Landed (#13049, #13052)         |
| 3   | The restart-404 recovery in the socket server is removed, because nothing can expire.                                                                                                                                                 | Landed (#13052, #13053)         |
| 4   | One explicit session key, the `x-auto-mobile-mcp-session-id` header, is the only key for per-session tool binding. The in-band `__mcpSessionId` argument stays accepted.                                                              | Landed (#13047, #13052, #13046) |
| 5   | Desktop keeps device binding by sending one generated id per app session on every call.                                                                                                                                               | Landed (#13046)                 |
| 6   | `tools/list`, `tools/call` and resources stay on our own request handlers, not SDK `registerTool` dispatch.                                                                                                                           | Decided                         |
| 7   | `tools/list_changed` stays an internal push, with a polling fallback in the proxy.                                                                                                                                                    | Landed (#13048)                 |
| 8   | Control-socket forwards run in process; the HTTP endpoint serves only the desktop app and external clients.                                                                                                                           | Landed (#11820)                 |

## Split packages (step 1)

Covered by the [split-packages decision record](../../decisions/mcp-sdk-v2-split-packages.md).
Facts worth knowing here: request handlers are registered by method string; four
v2 behaviour differences are bridged so the wire is unchanged
(`src/daemon/mcpError.ts`, `src/server/sdkMcpServer.ts`,
`src/server/stdioServerTransport.ts`, `src/daemon/socketServer/loopbackMcpClient.ts`);
the test helper is `test/helpers/fakeServerContext.ts`. Tests drive our servers with the
plain v2 `Client` (the v1-error-shape test client was retired; the boundary checker
rejects its reintroduction; its allowlist is now empty), so client error assertions see the SDK's unprefixed errors.

## Stateless daemon MCP layer (landed, #4678)

The daemon's HTTP endpoint (`/auto-mobile/streamable`) was the loopback hop the socket
server used to reach the tools until slice L (below); it is also called directly by the
desktop app's Kotlin client (`McpHttpClient`) and external clients. After this change:

- Each `POST` builds its own server and transport and closes them when the response
  closes. There is no `transports` map, no idle timer, no per-session in-flight
  counter and no "Session not found" `404`.
- Responses carry no `mcp-session-id`. `GET` and `DELETE` answer `405`.
- A legacy `initialize` followed by `tools/call` works without any session header, which
  is what the desktop client sends today (it only echoes `mcp-session-id` when the server
  returned one).
- Kept: the request admission gate, the DNS-rebinding `allowedHosts` check, SSE keepalive,
  and the session-context headers. Progress notifications travel on the POST's own SSE
  stream.
- Cancellation no longer rides on a transport session closing. In-flight requests are
  tracked, and daemon shutdown still cancels them with `DaemonHandoffInterruptionError`.
  When a socket disconnects, the socket server cancels that socket session's executions
  directly through `executionTracker`.

The cost of building a server per request depends on `registerMcpTools` and
`registerAllResources` being cheap. They were not: tools are now registered once and
shared, which cut the `tool-definitions` p50 from 10.07 ms to 0.16 ms (#13051).

### Restart-404 recovery removed

A daemon restart used to drop the loopback transport sessions; the socket server
detected the `404` and replayed the request on a fresh session. With no transport
session nothing can expire, so that detection and replay
(`isExpiredLoopbackMcpSession`, `retryExpiredMcpSession`) are deleted, and tests
assert there is none. Device-control transport recovery went with the loopback hop
in slice L.

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

Modern discovery advertises `tools.listChanged` and `resources.listChanged`. Each endpoint
lazily creates one in-memory event bus on its first modern request and bridges the process-wide
list-change broadcaster onto it. All per-request SDK handlers share that bus, so
`subscriptions/listen` can acknowledge and filter tools/resources list changes across requests.
The bridge detaches once admission stops and all requests close, or when the endpoint is cleared.
Listen streams use the same cancellation index, shutdown snapshot, disconnect abort, and
endpoint keepalive as other modern requests; SDK keepalive is disabled. Resource-URI updates
are not bridged and modern resources do not advertise `subscribe`. Cache hints remain private,
with a 5s tools-list TTL for clients without a listen stream. The stdio proxy keeps its existing
hand-built server and does not read this flag.

## Control-socket forwards in process (slice L, #11820)

The socket server no longer reaches the tools over its own HTTP endpoint. Each forward gets
its own MCP client and its own stateless server from the factory the endpoint uses
(`src/daemon/statelessMcpServerFactory.ts`: `buildMcpRequestContext` reads the context from
headers or from the forward's struct, `createStatelessMcpServer` builds the server), linked by
an `InMemoryTransport` pair in `InProcessMcpDispatcher` (`src/daemon/inProcessMcpDispatcher.ts`).

What the HTTP hop gave a forward is kept on purpose:

- **Wire bytes.** Every message crosses a JSON boundary (`JsonBoundaryTransport`: stringify,
  parse, `parseJSONRPCMessage`), as the streamable HTTP transports do, so `undefined` fields
  drop and shared references break exactly as before. Errors still pass through
  `LoopbackMcpClient`'s v1 mapping, and an aborted call still rejects with the caller's own
  abort reason.
- **Async context.** The HTTP server's request handler ran outside the socket chain's
  AsyncLocalStorage stores. The dispatcher enters each server from a root `AsyncResource`
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
would leak. A forwarded `tools/call` of a trivial tool went from a p50 of about 0.4 to 0.5 ms
over the HTTP hop to about 0.3 ms in process.

Deleted with the hop: the loopback client pool and its idle close, `loopbackMcpFetch` and
`LoopbackMcpConnectionError`, the session-key fetch wrapper, the streamable HTTP
reconnection options and the device-control transport recovery (reconnect, pin, replay). The
`device_control_transport_failure` wire type stays: the proxy and the daemon client still
read it from a daemon of an older version. A per-execution-key idle timer remains only to
drop the cached Android append helper.

The HTTP endpoint now serves only the desktop app and external clients. It keeps the
admission gate, DNS-rebinding protection, SSE keepalive, session-context headers and its
`notifications/cancelled` resolution, which also matches a header-less cancellation by
request id when exactly one in-flight request has it.

## The one session key

`src/daemon/mcpSessionKey.ts` exports `MCP_SESSION_KEY_HEADER`
(`x-auto-mobile-mcp-session-id`) and `readMcpSessionKey(headers)`. This is the only key for
per-session tool binding and `tools/list` filtering in daemon mode.

- The socket server keys every forward's server on the socket session id (in process since
  #11820; it was this header on every loopback request before).
- The desktop client generates one id per app session and sends it in the same header on
  every call.
- Precedence (owner decision, #13315): the header wins. The exception is the daemon's own
  in-process forward (`InProcessMcpDispatcher`, which marks its request scope
  `trustedForwarder` and builds the server with `trustForwardedMcpSessionId`): the in-band
  `__mcpSessionId` the socket server injects names the originating client, so it outranks the
  forward's connection key. An in-band id from any other source, such as a plain HTTP client
  putting `__mcpSessionId` in the tool arguments beside a header, never overrides the header.
  A direct HTTP request with no header still falls back to its in-band id, so header-less
  clients keep working. `parseCallContext` is the single place this is resolved.
- The in-band `__mcpSessionId` argument is still accepted and stripped from tool
  arguments before schema validation (`stripInternalToolParams`). The earlier spike found
  `__mcpSessionId` was derived from a connection id; on a direct request it is just a
  fallback carrier for the same explicit key.
- An explicit `sessionUuid` argument still wins where a tool takes one.
- `tools/list` has no arguments, so the header is what lets an argument-less list be
  filtered per session.
- Direct stdio keeps its single "direct" slot.

Because every per-request server creates its own `SessionToolBinding`, the binding maps
move into a daemon-scoped `SessionToolBindingStore` that outlives any one server. Release
teardown subscribes once on the store rather than once per server, and a release clears a
binding exactly once. Unchanged by this: the cross-routing refusal
(`SessionOutsideBoundSessionError`), the #7005 profile exception, the #11602 plan-label
equivalence and the `__*` stripping. The question of whether in-band `__*` keys propagate
into nested calls is separate and unsettled (#11823).

See [Device ownership](../../using/device-ownership.md) for what the key means to a caller.

## Handlers stay ours

`tools/list`, `tools/call` and resource handlers stay registered by method string on the
low-level server, not through the SDK's `registerTool` dispatch. Moving to `registerTool`
would change what clients see: schemas would be produced by Zod 4 rather than the
current advertised definitions, error texts would come from the SDK, and per-session tool
filtering would need to be re-expressed in its dispatch. The wire must stay byte-identical
for external clients and the desktop app, which the wire-parity and
`schemas/tool-definitions.json` drift checks pin.

If this is revisited, a Zod 4 upgrade of the tool schemas is the prerequisite.

## list_changed: internal push plus polling fallback (landed, #4678)

A per-request server cannot hold a notification channel, so list-changed delivery does not
depend on one:

- Per-request servers are registered with `ephemeral: true`, tracked only until they close,
  and `notifyToolListChanged` does not send to them.
- The internal push is unchanged: `ListChangedBroadcaster` to the socket server's
  `notificationSubscribers` to `DaemonMcpProxy.onListChanged`, which makes the proxy emit
  `list_changed` to its own client.
- The proxy adds a fallback (`ToolListPoller`): if the subscription is not acknowledged or
  drops, it polls `tools/list` and `resources/list` on a slow interval, compares a hash and
  re-emits `list_changed` only when the hash changes. A push and a poll arriving together
  must not produce two emits.
- Outer-boundary `subscriptions/listen` support across hosts is unverified and out of scope.

## Tasks extension (#4668)

Owner decisions (2026-10-18): tasks are stored in SQLite so a restarted daemon still answers
`tasks/get` and `tasks/cancel`; a task holding a device keeps that session's lease alive while
it is `working` or `input_required`; finished tasks stay readable for minutes (10 by default);
`startDevice` is the first tool converted.

**SDK support.** `@modelcontextprotocol/server` and `client` 2.3.1 do not implement the
extension. They ship the 2025-11-25 core task vocabulary (`ttl`, `pollInterval`,
`tasks/result`, `tasks/list`, `params.task`) only as deprecated types "with no SDK runtime",
know the `tasks/*` method names for `Mcp-Name` header routing, and lift the per-request
`_meta` envelope (`io.modelcontextprotocol/clientCapabilities`) into `ctx.mcpReq.envelope` and
a request's top-level `inputResponses` into `ctx.mcpReq.inputResponses`. `server/discover` is
installed only on a server serving the 2026-07-28 era, which the daemon HTTP endpoint can
serve with `AUTOMOBILE_MCP_MODERN_ERA`. The separate
`@modelcontextprotocol/ext-tasks` package is client-side and not a dependency. The wire is
therefore implemented on our own handlers, per the extension specification (revision
2026-07-28 of modelcontextprotocol/ext-tasks).

**Negotiation.** A request declares the extension in its per-request client capabilities;
declarations are never remembered. A `tools/call` that did not declare it never gets a task,
and `tasks/get`, `tasks/update` and `tasks/cancel` without it answer `-32021`. Because there is
no `server/discover` on the 2025 era, the server advertises the extension in its `initialize`
result, and only to a client whose `initialize` declared it; every other client sees the
`initialize` result unchanged. Modern HTTP servers advertise it in `server/discover`.

The legacy advertisement is a deliberate AutoMobile extension of the spec (#13143).
SEP-2663 leaves the extension undefined on `2025-11-25`; retaining the conditional
`initialize` advertisement lets existing clients negotiate Tasks while modern HTTP serving
is opt-in. It is not gated on the legacy client's `protocolVersion`.

**Pieces** (`src/server/tasks/`):

- `TaskManager` (interface, `DefaultTaskManager`, test `FakeTaskManager`): ids from
  `IdGenerator`, time from the injected `Timer`, statuses `working`, `input_required`,
  `completed`, `failed`, `cancelled`; a terminal status never changes. `ttlMs` is null while a
  task runs and becomes terminal time plus retention minus creation once it settles. On first
  use, a manager fails every running task another daemon instance left behind ("Task
  interrupted"). A foreign session's task is reported exactly like a missing one.
- `McpTaskRepository` (`src/db/mcpTaskRepository.ts`, table `mcp_tasks`, migration
  `2026_10_18_000_mcp_tasks`): owner key, status, instance id, timestamps, retention, and the
  JSON result, error or input requests. Status writes are fenced on a running status. The table
  lives in the daemon's own `auto-mobile.db` (`src/db`), not in the host-wide session broker
  registry file, because a task is owned by a daemon's session key.
- `runAsTask(options, work)`: the seam a tool call opts into. When the request declared the
  extension, carries a session key and tasks are served, it creates the task durably, starts
  the work in the background under a policy-specific `AbortSignal` (`abort` passes the task's
  signal to the existing cooperative request-cancellation path; `detach` passes an independent
  signal unaffected by `tasks/cancel`), turns progress ticks into the task's `statusMessage`,
  and returns the `CreateTaskResult`; otherwise it runs the work synchronously. `currentTaskContext()` gives
  code inside the work the task id, `holdDeviceLease(sessionUuid)` and `requestInput(...)`.
- `TaskLeaseKeepalive`: the hook a task uses to keep a device session's lease alive until its work
  ends. `HeartbeatTaskLeaseKeepalive` renews the session through the session manager's own
  `recordHeartbeat` (the path the socket and HTTP heartbeat routes use, owner lease only, never
  the idle clocks) at once and then at half the session's heartbeat timeout (at most every
  second). A hold ends when the work settles (including work continuing after a detached
  cancellation), when the session ends under it, or at daemon shutdown
  (`releaseDaemonTaskLeases`). The daemon's per-request servers get the daemon-scoped instance
  from `createStatelessMcpServer`; direct stdio holds nothing.
- `TASK_ELIGIBILITY`: per-call eligibility and cancellation policy. `startDevice`,
  `executePlan` and `installApp` use cooperative `abort`; `videoRecording` with `action: "stop"`
  uses `detach` (#13090). Recording start and other actions stay synchronous, and calls from
  non-declaring clients still block. Cancelling a stop task promptly reports `cancelled` with
  a message that work continues, ending client polling while the stop finishes and keeps its
  device lease. Its later result cannot overwrite cancellation; later failures are logged at
  warning level. A second stop joins the existing in-flight stop, and the finalized artifact
  remains retrievable. `taskEligibleByName` adapts name allowlists to the `abort` policy.
  `startDevice`'s work holds
  the session it binds (`currentTaskContext()?.holdDeviceLease`) right after the bind, so the
  session cannot lapse before the client learns its id from `tasks/get`. The boot itself binds
  no session until it is ready, so `tasks/cancel` during the boot runs the existing
  undelivered-acquisition rollback: the boot is stopped and nothing stays bound.
  `executePlan` (#13088) holds its base and routed session as the handler starts and each label
  session once its label map is published (`holdTaskDeviceLeases`, idempotent per task). Its execution registers
  under the task's scope with the same binding key and session UUID, so `PlanExecutionLock`
  keeps blocking that session's calls until the plan ends; `tasks/cancel` aborts the task's
  signal, which the execution combines with its own, so the plan unwinds and ends its execution
  (releasing the lock) as a cancelled synchronous call does.
- `createSdkMcpServer` passes a `CreateTaskResult` through the SDK's `tools/call` result
  validation, which would otherwise stamp `content: []` on it.

**Scope.** Tasks are served by the daemon's per-request servers (HTTP endpoint and in-process
forwards); a task's owner is the explicit session key, because a keyless request's scope id is
one-off. Direct stdio serves no tasks.

**Stdio proxy relay.** The proxy (`src/server/proxyServer.ts`, `DaemonMcpProxy`) is a transparent
participant. It advertises the extension on `initialize` only to a declaring client, forwards a
`tools/call`'s declaration as a `tasks` field on the control-socket frame (`{ownerKey,
declared}`), and relays `tasks/get`, `tasks/update` (with the input responses the SDK lifts to
`ctx.mcpReq.inputResponses`) and `tasks/cancel`; an undeclared `tasks/*` request is refused with
the same `-32021` the daemon sends. The owner key is minted once per proxy process
(`proxy-tasks:<id>`), so a task stays reachable after the proxy reconnects to a restarted daemon;
the socket's own session id would not be. The daemon's in-process forward passes it to the
request server as `taskOwnerKey` and replays the declaration. The SDK client on that hop lifts
`resultType` off every result, so the forward restores it (`resultType: "task"` on a task handle,
`"complete"` on `tasks/*` results), and a `tasks/*` JSON-RPC error travels on the frame as
`jsonRpcError` so the proxy answers with the daemon's code, message and data. `tasks/*` frames
skip the socket's admission queue: a poll never waits behind a long call on the same socket. A
lost daemon connection is reconnected and the request asked once more; a daemon that stays
unreachable is an error, never an invented status. Device-binding tools are not relayed as
declared until the proxy binds the session from a completed task's result.
`notifications/tasks` push is out of scope (task polling only).

## Open questions and resolutions

| #   | Question                                                                                                                   | Resolution                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Can a stateless v2 server send progress on the POST's SSE stream, and does a client disconnect abort the handler's signal? | Resolved (#13049): progress rides the POST's own stream. Bun gives no client-disconnect signal, so `notifications/cancelled` is matched in-process by (session key, request id) and cancels through `executionTracker`. |
| 2   | Does a v2 stateless server still accept the legacy `initialize`?                                                           | Resolved (#13049): a legacy `initialize` is accepted, and a call without `initialize` works.                                                                                                                            |
| 3   | Where do `InMemoryTransport`, `StreamableHTTPError`, the ping request schema and `toJsonSchemaCompat` live in v2?          | Resolved in step 1: handlers use method strings, the ping shim is gone, `toJsonSchemaCompat` is replaced by `zod-to-json-schema` called directly, loopback errors are mapped in `LoopbackMcpClient`.                    |
| 4   | CJS to ESM interop risk from the spike.                                                                                    | Resolved: current version is 2.3.1, both packages ship CommonJS builds, and the repo bundles them at build time.                                                                                                        |
| 5   | Do direct desktop HTTP clients lose implicit device binding?                                                               | Resolved by owner decision (2026-10-17): desktop sends one generated id per app session in the session-key header (slice K, #13046).                                                                                    |
| 6   | `subscriptions/listen` support across hosts.                                                                               | Opt-in modern daemon HTTP clients receive tools/resources list changes on a shared endpoint bus; the stdio proxy retains internal push plus polling.                                                                    |

## Appendix: original spike assessment (2026-07-29)

Condensed from the #4666 spike; its go/no-go (staged: Apps on v1.x first, SDK v2
migration gating Tasks, Tunnels parked), file counts and CJS to ESM risk are
superseded by the decisions above. What still explains the design:

- **"SDK v2" is the split packages** (`@modelcontextprotocol/server` + `client`), not a
  v2 of the monolith `@modelcontextprotocol/sdk` (v1.x, protocol `2025-11-25`).
- **Tasks need v2.** The specified extension negotiates via `server/discover` and
  `_meta.io.modelcontextprotocol/clientCapabilities.extensions`, 2026-07-28
  constructs absent from v1.x. The 2025-11-25 core experimental Tasks API is
  incompatible and must not be built on. Apps (`io.modelcontextprotocol/ui`,
  `_meta.ui.resourceUri` plus a served `ui://` resource) does not require v2.
  Tunnels are a deployment feature orthogonal to the SDK and were parked.
- **v2 API shape:** `registerTool`/`registerResource` replace v1
  `setRequestHandler(ListTools|CallTool…)`; `serveStdio` takes a factory
  `(ctx) => McpServer` (per connection on stdio, per request on the
  `createMcpHandler` HTTP path); a stateful `StreamableHTTPServerTransport`
  (`sessionIdGenerator`, `onsessioninitialized`) still exists, so the SDK does not
  force every leg stateless. Zod 4 (the v2 schema requirement) was already a dependency.
- **Four stateful mechanisms keyed off a connection-scoped identity**, which is why a
  durable client-carried key was designed first:

  | Mechanism                                                                             | Where                                                                                                  | Stateless equivalent chosen                                                             |
  | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
  | `SessionToolBinding` maps `mcpSessionId` to `sessionUuid`, filters every `tools/list` | `src/server/SessionToolBinding.ts`, `src/server/index.ts`                                              | `x-auto-mobile-mcp-session-id` header (`tools/list` has no arguments to carry a handle) |
  | Daemon autolock routing keyed on a random per-connection `sessionId`                  | `src/daemon/socketServer.ts`                                                                           | socket session id forwarded as the session key                                          |
  | Per-session tool profiles                                                             | `src/features/toolSelection/SessionToolSelectionService.ts`, `SqliteSessionToolSelectionRepository.ts` | keyed on the same session key                                                           |
  | `tools/list_changed` push over a persistent connection                                | `src/server/proxyServer.ts`, `src/daemon/socketServer.ts`                                              | internal push kept; `ToolListPoller` fallback                                           |

  `__mcpSessionId` was never the durable handle: it derived from the random
  connection id. The durable, model-visible handle is the `sessionUuid` argument that
  `effectiveSessionUuid` already prefers.

- **Transport topology at spike time:** external client to proxy to daemon is a raw
  framed Unix socket (`DaemonMcpProxy` over `DaemonClient`), not Streamable HTTP;
  `StreamableHTTPServerTransport` was a daemon-internal loopback hop, which slice L
  later removed.

### Non-goals (unchanged from the epic)

- Taskifying short synchronous interaction tools (`tapOn`, `inputText`, `pressButton`).
- A serverless/edge redeployment: AutoMobile binds to local ADB/simctl and is
  intentionally stateful on its host; the stateless _protocol_ is served over a
  factory, but device state stays on the daemon.
