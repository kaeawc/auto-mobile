# MCP SDK v2 and stateless daemon migration

- Kind: decision
- Date: 2026-07-29
- Source: moved from `how-it-works/mcp/sdk-v2-stateless-migration.md`; #4665, #4666, #4677, #4678,
  #11820, #13046, #13047, #13048, #13049, #13051, #13052, #13053, #13067, #13143, #13315
- Shaped: [MCP SDK v2 and stateless daemon layer](../how-it-works/mcp/sdk-v2-stateless-migration.md)

## Context

The record began as the feasibility spike for #4666 (2026-07-29) under epic #4665. The spike's
go/no-go (staged: Apps on v1.x first, SDK v2 migration gating Tasks, Tunnels parked), file counts
and CJS to ESM risk were later replaced by owner decisions. What still explains the design:

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
  `createMcpHandler` HTTP path). A stateful `StreamableHTTPServerTransport`
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

## Options

- Keep the stateful loopback `StreamableHTTPServerTransport` (the SDK does not force every leg
  stateless).
- Serve each request statelessly, keyed by an explicit client-carried session key.
- Move `tools/list` and `tools/call` to SDK `registerTool` dispatch, or keep our own handlers.

## Decision

| #   | Decision                                                                                                                                                                                                      | Status                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | Adopt the SDK v2 split packages (`@modelcontextprotocol/server` and `client` 2.3.1, `@modelcontextprotocol/node` 2.1.1). See [MCP TypeScript SDK v2 split packages](2026-10-17-mcp-sdk-v2-split-packages.md). | Landed (step 1)                 |
| 2   | The daemon's internal MCP layer is stateless: a server and transport per request, no `mcp-session-id`, no transport session map.                                                                              | Landed (#13049, #13052)         |
| 3   | The restart-404 recovery in the socket server is removed, because nothing can expire.                                                                                                                         | Landed (#13052, #13053)         |
| 4   | One explicit session key, the `x-auto-mobile-mcp-session-id` header, is the only key for per-session tool binding. The in-band `__mcpSessionId` argument stays accepted.                                      | Landed (#13047, #13052, #13046) |
| 5   | Desktop keeps device binding by sending one generated id per app session on every call.                                                                                                                       | Landed (#13046)                 |
| 6   | `tools/list`, `tools/call` and resources stay on our own request handlers, not SDK `registerTool` dispatch.                                                                                                   | Decided                         |
| 7   | `tools/list_changed` stays an internal push, with a polling fallback in the proxy.                                                                                                                            | Landed (#13048)                 |
| 8   | Control-socket forwards run in process; the HTTP endpoint serves only the desktop app and external clients.                                                                                                   | Landed (#11820)                 |

- **Handlers stay ours.** Moving to `registerTool` would change what clients see: schemas would
  be produced by Zod 4 rather than the advertised definitions. Error texts would come from the
  SDK, and per-session tool filtering would need re-expressing in its dispatch. If revisited, a
  Zod 4 upgrade of the tool schemas is the prerequisite.
- **Session key precedence** (owner decision, #13315): the header wins, except for the daemon's
  own in-process forward.
- **Tasks** (owner decisions, 2026-10-18): stored in SQLite so a restarted daemon still answers
  `tasks/get` and `tasks/cancel`. A task holding a device keeps its session lease alive while
  `working` or `input_required`. Finished tasks stay readable for minutes (10 by default).
  `startDevice` was the first tool converted.
- **Legacy Tasks advertisement** (#13143): retaining the conditional `initialize` advertisement
  lets existing clients negotiate Tasks while modern HTTP serving is opt-in.

## Consequences

- Building a server per request needed `registerMcpTools` and `registerAllResources` to be cheap;
  registering tools once and sharing them cut the `tool-definitions` p50 from 10.07 ms to 0.16 ms
  (#13051).
- A daemon restart used to drop the loopback transport sessions, and the socket server detected
  the `404` and replayed on a fresh session. That detection and replay
  (`isExpiredLoopbackMcpSession`, `retryExpiredMcpSession`) were deleted.
- Slice L (#11820) moved control-socket forwards in process. The HTTP server's request handler
  had run outside the socket chain's AsyncLocalStorage stores, so the dispatcher roots each server
  in a captured `AsyncResource`. A forwarded trivial `tools/call` went from a p50 of about
  0.4–0.5 ms over the HTTP hop to about 0.3 ms. Deleted with the hop: the loopback client pool
  and its idle close, `loopbackMcpFetch` and `LoopbackMcpConnectionError`, the session-key fetch
  wrapper, the streamable HTTP reconnection options and device-control transport recovery.
- The v1-error-shape test client was retired; the boundary checker's allowlist is empty.

Open questions and their resolutions:

| #   | Question                                                                                                                   | Resolution                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Can a stateless v2 server send progress on the POST's SSE stream, and does a client disconnect abort the handler's signal? | Resolved (#13049): progress rides the POST's own stream. Bun gives no client-disconnect signal, so `notifications/cancelled` is matched in-process by (session key, request id) and cancels through `executionTracker`. |
| 2   | Does a v2 stateless server still accept the legacy `initialize`?                                                           | Resolved (#13049): a legacy `initialize` is accepted, and a call without `initialize` works.                                                                                                                            |
| 3   | Where do `InMemoryTransport`, `StreamableHTTPError`, the ping request schema and `toJsonSchemaCompat` live in v2?          | Resolved in step 1: handlers use method strings, the ping shim is gone, `toJsonSchemaCompat` is replaced by `zod-to-json-schema` called directly, loopback errors are mapped in `LoopbackMcpClient`.                    |
| 4   | CJS to ESM interop risk from the spike.                                                                                    | Resolved: current version is 2.3.1, both packages ship CommonJS builds, and the repo bundles them at build time.                                                                                                        |
| 5   | Do direct desktop HTTP clients lose implicit device binding?                                                               | Resolved by owner decision (2026-10-17): desktop sends one generated id per app session in the session-key header (slice K, #13046).                                                                                    |
| 6   | `subscriptions/listen` support across hosts.                                                                               | Opt-in modern daemon HTTP clients receive tools/resources list changes on a shared endpoint bus; the stdio proxy retains internal push plus polling.                                                                    |
