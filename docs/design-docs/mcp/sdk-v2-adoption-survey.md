# MCP SDK v2 adoption survey

Which MCP SDK v2 and MCP 2026-07-28 features AutoMobile uses, which it does not, and
the order in which the unused ones are worth adopting. Companion to the
[SDK v2 and stateless daemon record](sdk-v2-stateless-migration.md), which covers what
is already migrated. Tracked under epic #4665.

## Baseline

- Installed: `@modelcontextprotocol/server` and `client` 2.3.1, `node` 2.1.1. SDK 2.4.0
  is published and adds the Skills extension, `ServerEvent` params, and an
  `outputSchema` `$ref` fix. Its upgrade notes do not touch us: no tool uses
  `x-mcp-header` or a `z.object().meta({ id })` output schema.
- The SDK negotiates the 2025-11-25 wire on `initialize`. The 2026-07-28 ("modern")
  era is reached only through `createMcpHandler` / `PerRequestHTTPServerTransport`,
  which the daemon does not use. The daemon serves the 2025 era statelessly.
- No confirmed host client sends a 2026-07-28 request yet. The community extension
  support matrix lists no client for Tasks at all, and lists Skills as partial in
  ChatGPT, fast-agent and MCP Inspector only.

### What 2026-07-28 changed

Stateless protocol (no `initialize`, no `Mcp-Session-Id`; version and capabilities in
every request's `_meta`); `server/discover`; `subscriptions/listen` replacing
`resources/subscribe` and the GET stream; multi round-trip requests (`input_required`
results instead of server-initiated elicitation, sampling and roots requests);
`ttlMs` / `cacheScope` on list and read results; Tasks moved to the
`io.modelcontextprotocol/tasks` extension with polling and `tasks/update`; SSE
resumability removed; `ping`, `logging/setLevel` and `roots/list_changed` removed;
Roots, Sampling and Logging deprecated; trace-context `_meta` keys; routing headers.

## Usage map

| Area                                                      | SDK / spec surface                                  | State in AutoMobile                                                                                                                                                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools: `inputSchema`, `outputSchema`, `structuredContent` | core                                                | Used by every tool. `structuredContent` mirrors the compact text; extras are opt-in.                                                                                                                                                  |
| Tool `annotations` and `title`                            | core                                                | Used (`src/server/toolAnnotations.ts`).                                                                                                                                                                                               |
| Progress and cancellation                                 | `notifications/progress`, `notifications/cancelled` | Used. Progress rides the request's own stream; socket disconnect cancels via the execution tracker.                                                                                                                                   |
| Resources and templates, `listChanged`                    | core                                                | Used broadly. `tools/list_changed` is an internal push with a hash-polling fallback in the proxy.                                                                                                                                     |
| Resource subscriptions                                    | `resources/subscribe`, `resources/updated`          | Used (`src/daemon/proxy/ResourceSubscriptions.ts`). Legacy API; `subscriptions/listen` is unused.                                                                                                                                     |
| Tasks extension                                           | extension, SDK ships types only                     | Used, own SQLite-backed implementation (`src/server/tasks/`, `src/daemon/tasks/`). Eligible per call: `startDevice`, `executePlan`, `installApp`, `videoRecording` stop. Advertised on a 2025-era `initialize` to a declaring client. |
| MCP Apps                                                  | `ui://` resources                                   | Used for `observe` (static snapshot); live shell is #4682.                                                                                                                                                                            |
| `resource_link` content blocks                            | core                                                | Unused.                                                                                                                                                                                                                               |
| Multi round-trip requests, elicitation                    | `inputRequired`, `acceptedContent`, legacy shim     | Unused. Tasks have `requestInput` plumbing no tool calls.                                                                                                                                                                             |
| Server `instructions`                                     | core                                                | Unused.                                                                                                                                                                                                                               |
| Completions                                               | `completable`                                       | Unused.                                                                                                                                                                                                                               |
| `server/discover`, cache hints (`ttlMs`, `cacheScope`)    | modern era                                          | Unused.                                                                                                                                                                                                                               |
| `subscriptions/listen`                                    | modern era                                          | Unused.                                                                                                                                                                                                                               |
| Skills over MCP                                           | SDK 2.4.0 `ext/skills`                              | Unused.                                                                                                                                                                                                                               |
| Trace context `_meta`                                     | `traceparent`, `tracestate`, `baggage`              | Unused.                                                                                                                                                                                                                               |
| Auth (bearer, protected-resource metadata, OAuth client)  | SDK server and client helpers                       | Unused. The HTTP ingress is loopback with a per-daemon random token and a host allowlist.                                                                                                                                             |
| Sampling, Roots                                           | deprecated                                          | Unused; do not adopt.                                                                                                                                                                                                                 |
| Logging                                                   | deprecated                                          | `sendLoggingMessage` only inside the stdio proxy; do not extend.                                                                                                                                                                      |
| SSE resumability / event store                            | removed from the spec                               | Unused; do not adopt.                                                                                                                                                                                                                 |
| Tunnels                                                   | Anthropic product, not SDK or spec                  | Not used; see [Tunnels](#tunnels).                                                                                                                                                                                                    |

## Ranked proposals

Rank is value to the agent (the primary consumer) first, then to a human supervisor,
divided by effort and risk, and discounted by real client support.

| #   | Proposal                                                                                                                                            | Benefit                                                                                                                                                                        | Effort                   | Risk                                                                                                                         | Depends on                                            | Issue        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------ |
| 1   | Return large non-image artifacts (video exports, session logs, exported plans) as `resource_link`, inline payload opt-in                            | Fewer model-context bytes and client spills on big results; works on every client, since `automobile://` resources already exist                                               | S-M                      | Low-medium: a client that never fetches links loses the payload, so images and small results stay inline                     | Per-tool byte measurement                             | #13942       |
| 2   | Byte-identical, deterministic `tools/list`                                                                                                          | Stable client list caches and LLM prompt-cache hits; the spec now says SHOULD                                                                                                  | S                        | Low                                                                                                                          | none                                                  | #13943       |
| 3   | Choose further Tasks-eligible tools from measured durations (snapshot create/restore, large `putAppFile`, cold-boot kill, uninstall with data wipe) | Long device operations stop holding a request open; survives client reconnects                                                                                                 | S to measure, M per tool | Low (opt-in per request)                                                                                                     | Device time for measurement; a Tasks-declaring client | #13944       |
| 4   | Publish a usage skill through the Skills extension                                                                                                  | Workflow guidance (session binding, observe before act, acquisition) pulled on demand instead of sitting in every context; the alternative to a permanent `instructions` block | S-M                      | Low-medium: few hosts consume it yet; content must stay current with the tools                                               | SDK 2.4.0                                             | #15430       |
| 5   | Elicitation through multi round-trip requests for an ambiguous `deviceId` and destructive confirmations                                             | A supervised host can ask instead of failing with a candidate list; the SDK's legacy shim serves pre-2026 clients with the same handler                                        | M                        | Medium: a result that asks a question stalls unattended agents, the majority of traffic                                      | Owner decision; must never block an unanswered call   | #13945       |
| 6   | Measured `instructions` block (at most about 300 tokens)                                                                                            | Unknown until benchmarked; adds tokens to every client                                                                                                                         | S                        | Low-medium                                                                                                                   | Benchmark; overlaps proposal 4                        | #13946       |
| 7   | Serve the modern era beside the 2025 era (`server/discover`, cache hints, `subscriptions/listen`, MRTR, spec-correct Tasks negotiation)             | High once a host speaks 2026-07-28; none today                                                                                                                                 | L                        | Medium-high: our own `tools/list` and `tools/call` handlers and the session-key model need an adapter around the SDK handler | A host client sending 2026-07-28                      | #13947       |
| 8   | Finish the live `observe` App shell, then an element picker                                                                                         | Human oversight; the picker also helps agents                                                                                                                                  | M                        | Medium, host-gated                                                                                                           | A host that renders Apps with session data            | #4682        |
| 9   | Remote device access through MCP Tunnels                                                                                                            | Cloud-hosted agents reaching an owner-run device bench                                                                                                                         | M-L                      | High: new non-loopback auth surface                                                                                          | Product decision                                      | #4674 (park) |

Opportunistic, not tracked: completions on resource-template URIs (few clients call
completion), trace-context propagation (needs an exporter first).

### Notes on the order

- Proposals 1 to 3 need no new client capability, so their benefit is immediate and
  their downside is bounded to our own output shaping. Measure before changing any
  default: clients differ in whether they follow `resource_link`.
- Proposals 4 and 6 are alternatives for the same job. Prefer the skill: it costs
  context only when a host loads it, and the same text works on both protocol eras.
- Proposal 7 gates several others (cache hints, `subscriptions/listen`, spec-correct
  Tasks negotiation). In the modern era the `Mcp-Session-Id` header is gone and the
  spec's answer to cross-call state is an explicit server-minted handle passed as an
  ordinary tool argument. AutoMobile's header key (`x-auto-mobile-mcp-session-id`) is
  an extension the host must be able to set; the in-band `__mcpSessionId` argument is
  the spec-shaped path and must keep working.
- Tasks remain opt-in per request. Nothing that returns in under about two seconds
  should become a task.

### Not recommended

SSE resumption or an event store (removed from the spec; a broken stream means
re-issuing the request, and tasks already give a durable handle), sampling and roots
(deprecated), per-request log level (logging is deprecated), server-side request
batching, and taskifying short interaction tools (`tapOn`, `inputText`, `pressButton`).

## Tunnels

MCP Tunnels is an Anthropic research-preview product, not part of the SDK or the
specification. An outbound-only `cloudflared` connector plus an Anthropic proxy run in
the customer's network; the proxy terminates inner TLS and routes each request to an
upstream MCP server by hostname. The tunnel carries traffic but does not authenticate
to the upstream server: each MCP server brings its own OAuth or bearer token. The
consumers are Claude Managed Agents and the Messages API MCP connector; a tunnel made in
the Console is not available as a claude.ai connector.

Fit against the daemon:

- **What it would add:** a cloud-hosted agent reaching devices on a private bench or
  emulator farm without inbound ports. Local clients (Claude Code, Cursor, IDE plugins)
  already reach the daemon through the stdio proxy and need nothing.
- **What the daemon lacks for it:** a non-loopback Streamable HTTP endpoint with real
  authorization. The ingress is loopback-only with one random token and a host
  allowlist. A tunnel needs OAuth (the SDK has bearer-verification and
  protected-resource-metadata helpers) and the tunnel hostname in the allowlist.
- **Semantics that do not carry over:** a hosted MCP connector sends static headers, so
  the per-conversation session key header cannot be set; binding would rely on the
  in-band `__mcpSessionId` handle. The proxy-side liveness that keeps a device lease
  alive has no hosted equivalent; the lease keepalive Tasks already use is the closest
  mechanism.
- **Recommendation:** park. Revisit only if supporting cloud-hosted agents against
  owner-run device benches becomes a product goal; the prerequisite work is the auth
  surface, not the tunnel.

## Sources

MCP [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
[Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview),
[Skills extension](https://modelcontextprotocol.io/extensions/skills/overview),
[extension support matrix](https://modelcontextprotocol.io/extensions/client-matrix),
[MCP tunnels](https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/overview),
and the TypeScript SDK v2 release notes.
