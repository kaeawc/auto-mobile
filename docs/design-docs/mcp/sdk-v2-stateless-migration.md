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

## What actually shipped (verified 2026-07-29)

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

## v2 API surface — empirically confirmed

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

## Collision map — stateful mechanisms vs. the stateless core

Re-verified against `main` (`a3ddc8067`). Four mechanisms key off a stable,
connection-scoped session identity that the stateless core removes.

| #   | Mechanism                                                                                                                                                                                                                              | Where                                                                                                  | Stateless-core equivalent                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Session identity as primary key.** `SessionToolBinding` is `Map<mcpSessionId → sessionUuid>`; used on every `tools/list` to filter visible tools.                                                                                    | `src/server/SessionToolBinding.ts`, `src/server/index.ts` (~L274)                                      | Partly seamed: `effectiveSessionUuid()` already _prefers_ an explicit `sessionUuid` tool argument over the connection id (`SessionToolBinding.ts:4-13`). **But `tools/list` carries no arguments**, so today it recovers the UUID only via the connection-bound map — which the stateless model removes. See the **open design question** below.                         |
| 2   | **Device autolock routing (daemon).** Per-connection `sessionId = randomUUID()` keys `sessions` / `clientSockets` / `notificationSubscribers`; `getMcpForwardKey` derives the autolock key; disconnect calls `clearBoundMcpClientKey`. | `src/daemon/socketServer.ts:300,357,382,469,629,716`                                                   | The daemon owns its **own** transport (Unix socket + a daemon-internal HTTP hop), so it can keep a connection id internally. The change is at the _external_ client boundary: route on a durable client-carried handle, not the random connection id.                                                                                                                    |
| 3   | **Per-session tool profiles.** Which exact tools are enabled, persisted per session.                                                                                                                                                   | `src/features/toolSelection/SessionToolSelectionService.ts`, `SqliteSessionToolSelectionRepository.ts` | Re-key on the durable client-carried handle instead of the connection id.                                                                                                                                                                                                                                                                                                |
| 4   | **`tools/list_changed` push.** `proxy.onListChanged → server.sendToolListChanged()` → daemon `notificationSubscribers` fan-out. A server→client push over a persistent connection.                                                     | `src/server/proxyServer.ts:61-67`, `src/daemon/socketServer.ts:382`                                    | The 2026-07-28 core provides an **opt-in subscription channel** for server→client notifications (`subscriptions/listen`); `tools/list` re-polling is the compatibility fallback, not the only option. The **internal** proxy↔daemon channel is our own socket and can keep pushing regardless. Confirm the exact subscription surface and host support in the migration. |

### Open design question the migration must answer first

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

## Transport topology (so the migration targets the right hop)

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

## Answers to the spike's acceptance questions

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

## Migration size estimate

**Blast radius: 8 files import the SDK** —
`src/index.ts`, `src/types/mcp-sdk.d.ts`, `src/server/{index,proxyServer,toolRegistry,resourceRegistry}.ts`,
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

### Unverified — resolve in the migration's first commit

- Exact v2 `PingRequestSchema` / low-level request-handler escape hatch for
  handlers without a `registerX` helper.
- The exact `subscriptions/listen` surface and which hosts honor it.
- Whether the daemon-internal loopback hop stays on `StreamableHTTPServerTransport`
  (stateful) or moves to the stateless model too — a topology decision, not a
  blocker.

## Follow-up child issues to file on the epic

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

## Non-goals (unchanged from the epic)

- Taskifying short synchronous interaction tools (`tapOn`, `inputText`,
  `pressButton`).
- A serverless/edge redeployment — AutoMobile binds to local ADB/simctl and is
  intentionally stateful on its host; the stateless _protocol_ is served over a
  factory, but device state stays on the daemon.
