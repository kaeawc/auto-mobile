# SDK v2 / stateless-core migration — impact assessment (spike)

Status: **Spike complete — go/no-go below.** Tracking issue
[#4666](https://github.com/kaeawc/auto-mobile/issues/4666); epic
[#4665](https://github.com/kaeawc/auto-mobile/issues/4665).

This is the feasibility assessment that gates the Tasks
([#4668](https://github.com/kaeawc/auto-mobile/issues/4668)) and Apps
([#4669](https://github.com/kaeawc/auto-mobile/issues/4669)) children. It maps
AutoMobile's session-stateful mechanisms onto the MCP 2026-07-28 stateless core,
sizes the TypeScript SDK v2 migration, and gives a sequenced go/no-go. No
production code changes ship from the spike itself.

## TL;DR — go/no-go

**GO, staged — do not migrate everything at once.**

1. **Apps ([#4669]) first, on the current v1.x SDK.** MCP Apps does **not**
   require SDK v2. It is server-side just a tool declaring a `ui://` resource
   plus a served resource body; the ecosystem libraries (`@mcp-ui/*`,
   `@modelcontextprotocol/ext-apps`) predate the v2 GA. Ship it against
   `@modelcontextprotocol/sdk ^1.x` and get visible value without touching the
   transport.
2. **A dedicated "migrate to SDK v2 + stateless core" issue gates Tasks.** The
   Tasks extension *as specified* is built on 2026-07-28 mechanics
   (`server/discover` advertisement + per-request `_meta` extension
   negotiation) that the v1.x monolith (protocol `2025-11-25`) does not speak.
   Tasks therefore requires v2. File the migration as its own child (draft
   below) — it is distinct from this spike and from
   [#4668](https://github.com/kaeawc/auto-mobile/issues/4668).
3. **Tasks ([#4668]) after the migration lands.**
4. **Tunnels ([#4674]): park.** Research-preview, Cloudflare-dependent, not
   exposed as a claude.ai connector, and orthogonal to v2. Re-evaluate once the
   migration settles the transport story.

The migration is a **contained refactor, not a rewrite**: 8 files import the
SDK, zod v4 (the v2 schema requirement) is already a dependency, and the
explicit-handle seam the stateless core prescribes already exists in the code.
The one real friction is CJS→ESM, mitigated below.

## What actually shipped (verified 2026-07-29)

The issue was drafted against `@beta` packages; that tag is now stale. Verified
against the public npm registry and the primary specs:

| Package | Latest | Notes |
| --- | --- | --- |
| `@modelcontextprotocol/server` | **`2.0.0`** (GA, 2026-07-27) | `type: module` (ESM-only), deps `zod ^4.2.0` + `@modelcontextprotocol/core`. **No surviving `beta`/`next` dist-tag** — only `latest: 2.0.0`. |
| `@modelcontextprotocol/client` | **`2.0.0`** (GA, 2026-07-27) | Same lineage. |
| `@modelcontextprotocol/sdk` (monolith) | `1.30.0` | Still v1.x, speaks protocol `2025-11-25`. **Not** npm-deprecated, but the SDK team's language is "retired in favor of" the split packages. Our `^1.26.0` pin floats to `1.30.0`. |
| `@mcp-ui/client` / `@mcp-ui/server` | `7.1.1` / `6.1.0` | Community MCP-UI project; pre-dates v2. |
| `@modelcontextprotocol/ext-apps` | `1.7.5` | Official Apps extension package (an `App` class). |

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

## v2 API surface — empirically confirmed

A throwaway server (v2 packages installed in an isolated scratch dir, never in
this repo's manifest) type-checked clean against the real `2.0.0` `.d.ts`. The
shape:

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

// Stateless core: a fresh server is built PER request-context via a factory,
// not a long-lived singleton. This is the concrete manifestation of "no
// initialize handshake, no Mcp-Session-Id".
await serveStdio((_ctx) => {
  const server = new McpServer({ name: "AutoMobile", version });
  server.registerTool(
    "echo",
    { description: "…", inputSchema: z.object({ text: z.string() }) },
    async ({ text }) => ({ content: [{ type: "text", text }] })
  );
  server.registerResource(
    "observe-ui",
    "ui://automobile/observe",
    { description: "…", mimeType: "text/html;profile=mcp-app" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/html", text }] })
  );
  return server;
});
```

Confirmed facts:

- **`registerTool` / `registerResource`** (declarative, Standard-Schema input)
  **replace** the v1 `server.server.setRequestHandler(ListToolsRequestSchema |
  CallToolRequestSchema | …)` wiring.
- **`serveStdio` takes a factory `(ctx: McpRequestContext) => McpServer`**, not a
  singleton. Each request context builds its own server — the stateless model in
  the type system.
- **Tasks + discovery are first-class v2 server exports**: `CreateTaskResult`,
  `GetTaskRequest`, `GetTaskResult`, `inputRequired`, `DiscoverRequest`,
  `MissingRequiredClientCapabilityError`, `ProtocolEra`.
- **A stateful HTTP path still exists**: `StreamableHTTPServerTransport` with
  `sessionIdGenerator` + `onsessioninitialized` / `onsessionclosed`. So v2 does
  **not** force our *internal* transport fully stateless — only the
  protocol-level stdio path is factory-per-context. This matters for the
  proxy/daemon boundary (below).

## Collision map — stateful mechanisms vs. the stateless core

Re-verified against `main` (`a3ddc8067`). Four mechanisms key off a stable,
connection-scoped session identity that the stateless core removes.

| # | Mechanism | Where | Stateless-core equivalent |
| --- | --- | --- | --- |
| 1 | **Session identity as primary key.** `SessionToolBinding` is `Map<mcpSessionId → sessionUuid>`; used on every `tools/list` to filter visible tools. | `src/server/SessionToolBinding.ts`, `src/server/index.ts` (~L274) | **Already seamed.** `effectiveSessionUuid()` already *prefers* an explicit `sessionUuid` argument over the connection id (`SessionToolBinding.ts:4-13`). Promote the explicit-handle path from fallback to primary. |
| 2 | **Device autolock routing (daemon).** Per-connection `sessionId = randomUUID()` keys `sessions` / `clientSockets` / `notificationSubscribers`; `getMcpForwardKey` derives the autolock key; disconnect calls `clearBoundMcpClientKey`. | `src/daemon/socketServer.ts:300,357,382,469,629,716` | The daemon owns its **own** Unix-socket transport (not the 2026-07-28 stdio path), so it may keep a connection id. The change is at the *external* client boundary: route on the explicit handle the client now threads. |
| 3 | **Per-session tool profiles.** Which tools are enabled, persisted per session. | `src/features/toolCapabilities/SessionToolProfileService.ts`, `SqliteSessionToolProfileRepository.ts` | Re-key on the explicit client-supplied handle instead of the connection id. |
| 4 | **`tools/list_changed` push.** `proxy.onListChanged → server.sendToolListChanged()` → daemon `notificationSubscribers` fan-out. A server→client push over a persistent connection. | `src/server/proxyServer.ts:61-67`, `src/daemon/socketServer.ts:382` | Stateless request/response has no server→client push at the *outer* client boundary — clients re-poll `tools/list`. The **internal** proxy↔daemon channel is our own socket and can keep push. (Tie-in: the Tasks extension is polling-first for exactly this reason.) |

**Why this is a migration and not a wall.** The explicit-handle pattern the
stateless spec prescribes ("server-issued handles passed as ordinary tool
arguments") already exists: the daemon injects `__mcpSessionId` before forwarding
(`socketServer.ts:2079,2089`), `toolRegistry.ts:261` and `deviceTools.ts:321`
route on it, `index.ts:87` strips it before schema validation, and a test pins
the behavior (`test/server/mcpSessionAutolockRouting.test.ts`). The migration
promotes that fallback to primary and swaps the outer push channel for polling.

## Answers to the spike's acceptance questions

- **Can Tasks land without full v2 migration?** **No.** The specified extension
  negotiates via `server/discover` + `_meta.io.modelcontextprotocol/clientCapabilities.extensions`,
  both 2026-07-28 constructs absent from v1.x. (A *different, incompatible*
  experimental Tasks API shipped in the 2025-11-25 core; the spec blog warns it
  must migrate to the new lifecycle. Don't build on the old one.)
- **Can Apps land without full v2 migration?** **Yes, qualified.** Apps is
  server-side `_meta.ui.resourceUri` + a served `ui://` resource + a postMessage
  broker, and `@mcp-ui/*` / `@modelcontextprotocol/ext-apps` target the pre-v2
  ecosystem. On v1.x you adopt it under the older handshake; the 2026-07-28
  discovery/negotiation is a v2 nicety, not a requirement. (Apps negotiates
  under the `io.modelcontextprotocol/ui` extension key.)
- **Tunnels?** Deployment/connectivity feature, orthogonal to the SDK. Park.

## Migration size estimate

**Blast radius: 8 files import the SDK** —
`src/index.ts`, `src/types/mcp-sdk.d.ts`, `src/server/{index,proxyServer,toolRegistry,resourceRegistry}.ts`,
`src/daemon/{daemon,socketServer}.ts`. Subpaths: `types.js` (8), `server/mcp.js`
(4), `server/stdio.js` (2), `server/index.js` (2), `server/streamableHttp.js`
(1), `client/{streamableHttp,index}.js` (1 each).

Work items, roughly ordered:

1. **Registration rewrite** — `setRequestHandler(ListTools/CallTool/…)` in
   `index.ts` + `toolRegistry.ts` / `resourceRegistry.ts` → `registerTool` /
   `registerResource`. **zod `^4.3.5` is already a dep and used in 34 `src/`
   files**, so the Standard-Schema requirement is pre-satisfied — no new schema
   library.
2. **Transport** — singleton `McpServer` → `serveStdio((ctx) => McpServer)`
   factory for the stdio path. Keep `StreamableHTTPServerTransport` (with its
   session mode) available for the proxy/daemon boundary if we want to retain
   push there.
3. **Session identity** — promote `__mcpSessionId` from fallback to primary in
   `effectiveSessionUuid`; the daemon forward-key logic already consumes it.
4. **`list_changed`** — outer client boundary degrades to poll; internal
   proxy↔daemon push preserved over our own socket.
5. **Ping / misc handlers** — the `require("@modelcontextprotocol/sdk/types.js").PingRequestSchema`
   runtime-access shim (`index.ts`) needs a v2 equivalent.

**Primary risk — CJS→ESM.** The repo is CommonJS; the v2 packages are ESM-only
(`type: module`). Mitigations, in preference order: (a) `index.ts` **already**
consumes the SDK via dynamic `await import("…/stdio.js")`, and dynamic import of
ESM from CJS is supported — the migration can lean on that at the few entry
points; (b) if broader, a scoped ESM conversion of the `src/server` +
`src/daemon` entry modules. Do **not** attempt a whole-repo ESM flip in the same
PR.

Risk list: CJS→ESM interop (medium); daemon forward-key correctness under
handle-primary routing (medium — covered by the existing autolock routing
tests, extend them); outer-client `list_changed` regressing to poll-only (low —
Tasks/Apps are poll-tolerant by design); v2 GA API churn (low — `2.0.0` is GA,
not beta).

### Unverified — resolve in the migration's first commit
- Exact v2 `PingRequestSchema` / low-level request-handler escape hatch for
  handlers without a `registerX` helper.
- Whether we keep the proxy on `StreamableHTTPServerTransport` (stateful) or move
  it to the stateless factory model too — a transport-topology decision, not a
  blocker.

## Follow-up child issues to file on the epic

1. **`migrate(mcp): adopt SDK v2 server/client + stateless core`** — the
   registration rewrite, stdio factory, `__mcpSessionId`-primary routing, and
   `list_changed` poll fallback above. **Gates [#4668].** (New — file this.)
2. **[#4669] Apps for `observe`** — proceed **now on v1.x**; the spike clears it
   of a v2 dependency.
3. **[#4668] Tasks (`executePlan` first)** — after issue 1 lands.
4. **[#4674] Tunnels** — park; re-evaluate post-migration.

## Non-goals (unchanged from the epic)

- Taskifying short synchronous interaction tools (`tapOn`, `inputText`,
  `pressButton`).
- A serverless/edge redeployment — AutoMobile binds to local ADB/simctl and is
  intentionally stateful on its host; the stateless *protocol* is served over a
  factory, but device state stays on the daemon.
