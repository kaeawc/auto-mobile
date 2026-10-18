# MCP SDK v2 and stateless daemon layer: decision record

Status: **landed (#4678)**, epic [#4665](https://github.com/kaeawc/auto-mobile/issues/4665).
Step 1 (SDK v2 split packages), the stateless daemon layer (slices A to K) and slice L
(control-socket forwards in process, #11820) are on main.

This record began as the feasibility spike for #4666 (kept in full at the end as the
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
(`src/server/mcpError.ts`, `src/server/sdkMcpServer.ts`,
`src/server/stdioServerTransport.ts`, `src/daemon/socketServer/loopbackMcpClient.ts`);
test helpers are `test/helpers/fakeServerContext.ts` and
`test/helpers/v1ViewMcpClient.ts`.

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

### What shipped

| PR             | Slice  | What it did                                                                                                                                                                |
| -------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #13042         | step 1 | SDK v2 split packages and the v1-compat bridges.                                                                                                                           |
| #13050         | review | Review fixes for step 1. v1 also advertised `tools.listChanged`, and v2 now does too. Remaining intentional wire diffs: notification key order, and abort-after-`onclose`. |
| #13047         | A      | Session key contract and the daemon-scoped `SessionToolBindingStore`.                                                                                                      |
| #13049         | B      | Stateless HTTP endpoint: a server and transport per POST, no `mcp-session-id`, `GET` and `DELETE` answer `405`.                                                            |
| #13052         | C      | Loopback cleanup: no restart-404 replay, the session-key header is sent on every forward, and a socket disconnect cancels that session's executions.                       |
| #13053         | C2     | Bindings are forgotten on disconnect; keyless bindings are supported.                                                                                                      |
| #13048         | F      | Ephemeral per-request servers and `ToolListPoller`.                                                                                                                        |
| #13051         | perf   | Tools registered once instead of per request.                                                                                                                              |
| #13041, #13054 | G      | Wire baseline and its fixes.                                                                                                                                               |
| #13044         | H1     | Boundary guard (`scripts/check-mcp-sdk-boundary.ts`), now also covering `test/`.                                                                                           |
| #13046         | K      | Desktop sends the session-key header.                                                                                                                                      |
| #11820         | L      | Control-socket forwards run in process; the loopback client pool and device-control transport recovery are deleted.                                                        |
| (this change)  | H2     | Last boundary allowlist entries removed (`sessionIdGenerator` is omitted rather than set to `undefined`); the allowlist is empty.                                          |

### Restart-404 recovery removed

Before this change, a daemon restart dropped the loopback transport sessions, and the
socket server detected the resulting `404` ("expired loopback session") and replayed the
request on a fresh session. With no transport session there is nothing to expire, so that
detection and replay (`isExpiredLoopbackMcpSession`, `retryExpiredMcpSession`), the session
termination step in the loopback client pool, and its timeout constant are deleted. The
tests that asserted the replay assert there is none. Device-control transport recovery went
with the loopback hop in slice L.

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

`src/server/mcpSessionKey.ts` exports `MCP_SESSION_KEY_HEADER`
(`x-auto-mobile-mcp-session-id`) and `readMcpSessionKey(headers)`. This is the only key for
per-session tool binding and `tools/list` filtering in daemon mode.

- The socket server keys every forward's server on the socket session id (in process since
  #11820; it was this header on every loopback request before).
- The desktop client generates one id per app session and sends it in the same header on
  every call. The header is preferred over the in-band argument.
- The in-band `__mcpSessionId` argument is still accepted and stripped from tool
  arguments before schema validation (`stripInternalToolParams`). The earlier spike found
  `__mcpSessionId` was derived from a connection id; it is now just an alternative carrier
  for the same explicit key.
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
installed only on a server serving the 2026-07-28 era; ours serve the 2025 era. The separate
`@modelcontextprotocol/ext-tasks` package is client-side and not a dependency. The wire is
therefore implemented on our own handlers, per the extension specification (revision
2026-07-28 of modelcontextprotocol/ext-tasks).

**Negotiation.** A request declares the extension in its per-request client capabilities;
declarations are never remembered. A `tools/call` that did not declare it never gets a task,
and `tasks/get`, `tasks/update` and `tasks/cancel` without it answer `-32021`. Because there is
no `server/discover` on the 2025 era, the server advertises the extension in its `initialize`
result, and only to a client whose `initialize` declared it; every other client sees the
`initialize` result unchanged.

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
  the work in the background under the task's `AbortSignal` (aborted by `tasks/cancel`, which
  the existing `executionTracker` request-cancellation path turns into cooperative
  cancellation), turns progress ticks into the task's `statusMessage`, and returns the
  `CreateTaskResult`; otherwise it runs the work synchronously. `currentTaskContext()` gives
  code inside the work the task id, `holdDeviceLease(sessionUuid)` and `requestInput(...)`.
- `TaskLeaseKeepalive`: the hook a task uses to keep a device session's lease alive until it is
  terminal. The default holds nothing; the session broker implements it with `startDevice`.
- `TASK_ELIGIBLE_TOOLS`: the tools whose call may become a task. Empty in this slice.
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
`notifications/tasks` push and `subscriptions/listen` are out of scope (polling only).

## Open questions and resolutions

| #   | Question                                                                                                                   | Resolution                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Can a stateless v2 server send progress on the POST's SSE stream, and does a client disconnect abort the handler's signal? | Resolved (#13049): progress rides the POST's own stream. Bun gives no client-disconnect signal, so `notifications/cancelled` is matched in-process by (session key, request id) and cancels through `executionTracker`. |
| 2   | Does a v2 stateless server still accept the legacy `initialize`?                                                           | Resolved (#13049): a legacy `initialize` is accepted, and a call without `initialize` works.                                                                                                                            |
| 3   | Where do `InMemoryTransport`, `StreamableHTTPError`, the ping request schema and `toJsonSchemaCompat` live in v2?          | Resolved in step 1: handlers use method strings, the ping shim is gone, `toJsonSchemaCompat` is replaced by `zod-to-json-schema` called directly, loopback errors are mapped in `LoopbackMcpClient`.                    |
| 4   | CJS to ESM interop risk from the spike.                                                                                    | Resolved: current version is 2.3.1, both packages ship CommonJS builds, and the repo bundles them at build time.                                                                                                        |
| 5   | Do direct desktop HTTP clients lose implicit device binding?                                                               | Resolved by owner decision (2026-10-17): desktop sends one generated id per app session in the session-key header (slice K, #13046).                                                                                    |
| 6   | `subscriptions/listen` support across hosts.                                                                               | Pending, out of scope: the internal push plus polling stands.                                                                                                                                                           |

## Appendix: original spike assessment (2026-07-29)

The text below is the original spike, kept for its version facts and collision map. Its
go/no-go, file counts and CJS to ESM risk are superseded by the decisions above.

Status: **Spike complete — go/no-go below.** Tracking issue
[#4666](https://github.com/kaeawc/auto-mobile/issues/4666); epic
[#4665](https://github.com/kaeawc/auto-mobile/issues/4665).

This is the feasibility assessment that gates the Tasks
([#4668](https://github.com/kaeawc/auto-mobile/issues/4668)) and Apps
([#4669](https://github.com/kaeawc/auto-mobile/issues/4669)) children. It maps
AutoMobile's session-stateful mechanisms onto the MCP 2026-07-28 stateless core,
sizes the TypeScript SDK v2 migration, and gives a sequenced go/no-go. No
production code changes ship from the spike itself.

### TL;DR — go/no-go

**GO, staged — do not migrate everything at once.**

1. **Apps ([#4669](https://github.com/kaeawc/auto-mobile/issues/4669)) first, on
   the current v1.x SDK.** MCP Apps does **not** require SDK v2. It is
   server-side just a tool declaring a `ui://` resource plus a served resource
   body; the ecosystem libraries (`@mcp-ui/*`,
   `@modelcontextprotocol/ext-apps`) predate the v2 GA. Ship it against
   `@modelcontextprotocol/sdk ^1.x` and get visible value without touching the
   transport.
2. **A dedicated "migrate to SDK v2 + stateless core" issue gates Tasks.** The
   Tasks extension _as specified_ is built on 2026-07-28 mechanics
   (`server/discover` advertisement + per-request `_meta` extension
   negotiation) that the v1.x monolith (protocol `2025-11-25`) does not speak.
   Tasks therefore requires v2. File the migration as its own child (draft
   below) — it is distinct from this spike and from
   [#4668](https://github.com/kaeawc/auto-mobile/issues/4668).
3. **Tasks ([#4668](https://github.com/kaeawc/auto-mobile/issues/4668)) after
   the migration lands.**
4. **Tunnels ([#4674](https://github.com/kaeawc/auto-mobile/issues/4674)):
   park.** Research-preview, Cloudflare-dependent, not exposed as a claude.ai
   connector, and orthogonal to v2. Re-evaluate once the migration settles the
   transport story.

The migration is a **contained refactor, not a rewrite**: 8 files import the
SDK, zod v4 (the v2 schema requirement) is already a dependency, and the
explicit-handle seam the stateless core prescribes already exists in the code.
The two things the migration must _design_, not just port, are (a) a durable
client-carried session identity to replace connection-scoped ids, and (b) the
notification channel — both called out below.

### What actually shipped (verified 2026-07-29)

The issue was drafted against `@beta` packages; that tag is now stale. Verified
against the public npm registry and the primary specs:

| Package                                | Latest            | Notes                                                                                                                                                                                                                                                                               |
| -------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@modelcontextprotocol/server`         | **`2.0.0`**       | Published `2026-07-27T23:55Z` on npm, announced with the [2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/). `type: module` (ESM-only), deps `zod ^4.2.0` + `@modelcontextprotocol/core`. **No surviving `beta`/`next` dist-tag** — only `latest: 2.0.0`. |
| `@modelcontextprotocol/client`         | **`2.0.0`**       | Same publish/announce timing and lineage.                                                                                                                                                                                                                                           |
| `@modelcontextprotocol/sdk` (monolith) | `1.30.0`          | Still v1.x, speaks protocol `2025-11-25`. **Not** npm-deprecated, but the SDK team's language is "retired in favor of" the split packages. Our `^1.26.0` pin floats to `1.30.0`.                                                                                                    |
| `@mcp-ui/client` / `@mcp-ui/server`    | `7.1.1` / `6.1.0` | Community MCP-UI project; pre-dates v2.                                                                                                                                                                                                                                             |
| `@modelcontextprotocol/ext-apps`       | `1.7.5`           | Official Apps extension package (an `App` class).                                                                                                                                                                                                                                   |

**"SDK v2" is the split, not a v2 of the monolith.** There is no
`@modelcontextprotocol/sdk@2`. The v2 story is `@modelcontextprotocol/server` +
`@modelcontextprotocol/client`.

Sources: [2026-07-28 spec blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/),
[SDK betas post](https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/),
[extensions overview](https://modelcontextprotocol.io/extensions/overview),
[Tasks extension](https://tasks.extensions.modelcontextprotocol.io/),
[MCP Apps blog](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/),
[MCP Tunnels docs](https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/overview),
npm registry (`npm view`, read-only).

### v2 API surface — empirically confirmed

A throwaway server (v2 packages installed in an isolated scratch dir, never in
this repo's manifest) type-checked clean against the real `2.0.0` `.d.ts`. The
shape (representative values inlined so the snippet stands alone):

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

const version = "0.0.0";
const uiHtml = "<html></html>";

// The module-scope singleton `new McpServer(...)` goes away: serveStdio takes a
// FACTORY. On the single long-lived stdio connection the factory builds one
// server per connection; per-REQUEST construction (the fully stateless path)
// lives on the HTTP handler, `createMcpHandler`. Either way there is no shared
// initialize/Mcp-Session-Id singleton.
await serveStdio((_ctx) => {
  const server = new McpServer({ name: "AutoMobile", version });
  server.registerTool(
    "echo",
    { description: "…", inputSchema: z.object({ text: z.string() }) },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  server.registerResource(
    "observe-ui",
    "ui://automobile/observe",
    { description: "…", mimeType: "text/html;profile=mcp-app" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/html", text: uiHtml }] }),
  );
  return server;
});
```

Confirmed facts:

- **`registerTool` / `registerResource`** (declarative, Standard-Schema input)
  **replace** the v1 `server.server.setRequestHandler(ListToolsRequestSchema |
  CallToolRequestSchema | …)` wiring.
- **`serveStdio` takes a factory `(ctx: McpRequestContext) => McpServer`**, not a
  singleton. For stdio (one connection) that factory runs per-connection; the
  per-request stateless construction is the `createMcpHandler` HTTP path. The
  common effect: no long-lived module-scope server, no `initialize`,
  no `Mcp-Session-Id`.
- **Tasks + discovery are first-class v2 server exports**: `CreateTaskResult`,
  `GetTaskRequest`, `GetTaskResult`, `inputRequired`, `DiscoverRequest`,
  `MissingRequiredClientCapabilityError`, `ProtocolEra`.
- **A stateful HTTP transport still exists**: `StreamableHTTPServerTransport`
  with `sessionIdGenerator` + `onsessioninitialized` / `onsessionclosed`. So the
  SDK does **not** force _every_ leg stateless — relevant to the daemon-internal
  HTTP hop (below).

### Collision map — stateful mechanisms vs. the stateless core

Re-verified against `main` (`a3ddc8067`). Four mechanisms key off a stable,
connection-scoped session identity that the stateless core removes.

| #   | Mechanism                                                                                                                                                                                                                              | Where                                                                                                  | Stateless-core equivalent                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Session identity as primary key.** `SessionToolBinding` is `Map<mcpSessionId → sessionUuid>`; used on every `tools/list` to filter visible tools.                                                                                    | `src/server/SessionToolBinding.ts`, `src/server/index.ts` (~L274)                                      | Partly seamed: `effectiveSessionUuid()` already _prefers_ an explicit `sessionUuid` tool argument over the connection id (`SessionToolBinding.ts:4-13`). **But `tools/list` carries no arguments**, so today it recovers the UUID only via the connection-bound map — which the stateless model removes. See the **open design question** below.                         |
| 2   | **Device autolock routing (daemon).** Per-connection `sessionId = randomUUID()` keys `sessions` / `clientSockets` / `notificationSubscribers`; `getMcpForwardKey` derives the autolock key; disconnect calls `clearBoundMcpClientKey`. | `src/daemon/socketServer.ts`                                                                           | The daemon owns its **own** transport (Unix socket + a daemon-internal HTTP hop), so it can keep a connection id internally. The change is at the _external_ client boundary: route on a durable client-carried handle, not the random connection id.                                                                                                                    |
| 3   | **Per-session tool profiles.** Which exact tools are enabled, persisted per session.                                                                                                                                                   | `src/features/toolSelection/SessionToolSelectionService.ts`, `SqliteSessionToolSelectionRepository.ts` | Re-key on the durable client-carried handle instead of the connection id.                                                                                                                                                                                                                                                                                                |
| 4   | **`tools/list_changed` push.** `proxy.onListChanged → server.sendToolListChanged()` → daemon `notificationSubscribers` fan-out. A server→client push over a persistent connection.                                                     | `src/server/proxyServer.ts:61-67`, `src/daemon/socketServer.ts:382`                                    | The 2026-07-28 core provides an **opt-in subscription channel** for server→client notifications (`subscriptions/listen`); `tools/list` re-polling is the compatibility fallback, not the only option. The **internal** proxy↔daemon channel is our own socket and can keep pushing regardless. Confirm the exact subscription surface and host support in the migration. |

#### Open design question the migration must answer first

The issue's "promote the explicit handle from fallback to primary" framing needs
one correction: **`__mcpSessionId` is not the durable handle** — it is derived
from the daemon's random per-connection id (`socketServer.ts:300`) and injected
proxy-side for autolock routing (`socketServer.ts:2079,2089`), the very kind of
connection-scoped identity the stateless core removes. The durable, model-visible
handle is the **`sessionUuid` tool argument** that `effectiveSessionUuid` already
prefers.

So the migration must, before re-keying anything:

1. **Define a client-carried session identity** (the `sessionUuid` handle, or an
   explicit successor) that the client threads on every request, including a
   concrete identity channel for **argument-less `tools/list`** — which today
   leans entirely on the connection binding and would otherwise lose
   session-filtered tool lists and implicit autolock continuity under a
   factory-per-context model.
2. Only then re-key `SessionToolBinding`, the tool-profile service, and the
   daemon forward key onto that handle.

The seam exists (the daemon already strips `__mcpSessionId` before schema
validation — `index.ts:87`; `mcpSessionAutolockRouting.test.ts` pins it), so this
is a design task, not a green-field one — but it is a **design** task, not a
mechanical rename.

### Transport topology (so the migration targets the right hop)

The external boundary and the internal boundary use **different** transports:

- **External client → proxy → daemon** is a **raw framed Unix socket**:
  `createProxyMcpServer` (`proxyServer.ts`) drives `DaemonMcpProxy`, which
  connects over `DaemonClient` (`src/daemon/client.ts`, `createConnection` on the
  socket path). This is **not** `StreamableHTTPServerTransport`.
- **`StreamableHTTPServerTransport` is a daemon-internal loopback hop**: the
  daemon's socket-server side opens a `StreamableHTTPClientTransport`
  (`socketServer.ts:2102`) to the daemon's own HTTP MCP server
  (`daemon.ts:479 startHttpServer`, transport constructed `daemon.ts:612`).

Consequence: the "keep a stateful HTTP session mode" option applies to the
**daemon socket-server → loopback MCP server** leg, not to "the proxy." The
external stdio/SSE boundary is where the 2026-07-28 stateless factory model
lands; the loopback HTTP leg can retain `sessionIdGenerator` if we choose.

### Answers to the spike's acceptance questions

- **Can Tasks land without full v2 migration?** **No.** The specified extension
  negotiates via `server/discover` + `_meta.io.modelcontextprotocol/clientCapabilities.extensions`,
  both 2026-07-28 constructs absent from v1.x. (A _different, incompatible_
  experimental Tasks API shipped in the 2025-11-25 core; the spec blog warns it
  must migrate to the new lifecycle. Don't build on the old one.)
- **Can Apps land without full v2 migration?** **Yes, qualified.** Apps is
  server-side `_meta.ui.resourceUri` + a served `ui://` resource + a postMessage
  broker, and `@mcp-ui/*` / `@modelcontextprotocol/ext-apps` target the pre-v2
  ecosystem. On v1.x you adopt it under the older handshake; the 2026-07-28
  discovery/negotiation is a v2 nicety, not a requirement. (Apps negotiates
  under the `io.modelcontextprotocol/ui` extension key.)
- **Tunnels?** Deployment/connectivity feature, orthogonal to the SDK. Park.

### Migration size estimate

**Blast radius: 8 files import the SDK** —
`src/index.ts`, the SDK type shim, `src/server/{index,proxyServer,toolRegistry,resourceRegistry}.ts`,
`src/daemon/{daemon,socketServer}.ts`. Subpaths: `types.js` (8), `server/mcp.js`
(4), `server/stdio.js` (2), `server/index.js` (2), `server/streamableHttp.js`
(1), `client/{streamableHttp,index}.js` (1 each).

Work items, roughly ordered:

1. **Session-identity design** (above) — the one true prerequisite; blocks the
   re-keying work in items 3–4.
2. **Registration rewrite** — `setRequestHandler(ListTools/CallTool/…)` in
   `index.ts` + `toolRegistry.ts` / `resourceRegistry.ts` → `registerTool` /
   `registerResource`. **zod `^4.3.5` is already a dep and used in 34 `src/`
   files**, so the Standard-Schema requirement is pre-satisfied — no new schema
   library.
3. **Transport** — module-scope `McpServer` → `serveStdio((ctx) => McpServer)`
   factory for the stdio path. Decide separately whether the daemon-internal
   loopback HTTP hop keeps `StreamableHTTPServerTransport` session mode.
4. **Session re-keying** — apply the item-1 handle to `effectiveSessionUuid`,
   the tool-profile service, and the daemon forward-key logic; extend the
   autolock routing tests.
5. **Notifications** — wire `subscriptions/listen` for opt-in clients at the
   outer boundary; keep the internal proxy↔daemon push over our own socket;
   `tools/list` re-poll as fallback.
6. **Ping / misc handlers** — the `require("@modelcontextprotocol/sdk/types.js").PingRequestSchema`
   runtime-access shim (`index.ts`) needs a v2 equivalent.

**Primary risk — CJS→ESM.** The repo is CommonJS; the v2 packages are ESM-only
(`type: module`). Mitigations, in preference order: (a) `index.ts` **already**
consumes the SDK via dynamic `await import("…/stdio.js")`, and dynamic import of
ESM from CJS is supported — the migration can lean on that at the few entry
points; (b) if broader, a scoped ESM conversion of the `src/server` +
`src/daemon` entry modules. Do **not** attempt a whole-repo ESM flip in the same
PR.

Risk list: session-identity design for argument-less `tools/list` (medium — the
one non-mechanical piece); CJS→ESM interop (medium); daemon forward-key
correctness under handle routing (medium — covered by the existing autolock
routing tests, extend them); v2 GA API churn (low — `2.0.0` is GA, not beta).

#### Unverified — resolve in the migration's first commit

- Exact v2 `PingRequestSchema` / low-level request-handler escape hatch for
  handlers without a `registerX` helper.
- The exact `subscriptions/listen` surface and which hosts honor it.
- Whether the daemon-internal loopback hop stays on `StreamableHTTPServerTransport`
  (stateful) or moves to the stateless model too — a topology decision, not a
  blocker.

### Follow-up child issues to file on the epic

1. **`migrate(mcp): adopt SDK v2 server/client + stateless core`** — the
   session-identity design, registration rewrite, stdio factory, handle-based
   routing, and `subscriptions/listen` notification path above. **Gates
   [#4668](https://github.com/kaeawc/auto-mobile/issues/4668).** (New — file
   this.)
2. **[#4669](https://github.com/kaeawc/auto-mobile/issues/4669) Apps for
   `observe`** — proceed **now on v1.x**; the spike clears it of a v2 dependency.
3. **[#4668](https://github.com/kaeawc/auto-mobile/issues/4668) Tasks
   (`executePlan` first)** — after issue 1 lands.
4. **[#4674](https://github.com/kaeawc/auto-mobile/issues/4674) Tunnels** —
   park; re-evaluate post-migration.

### Non-goals (unchanged from the epic)

- Taskifying short synchronous interaction tools (`tapOn`, `inputText`,
  `pressButton`).
- A serverless/edge redeployment — AutoMobile binds to local ADB/simctl and is
  intentionally stateful on its host; the stateless _protocol_ is served over a
  factory, but device state stays on the daemon.
