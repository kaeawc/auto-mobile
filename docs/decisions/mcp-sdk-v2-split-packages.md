# MCP TypeScript SDK v2 split packages

Status: accepted for #4678 (step 1 of 3: dependency swap and handler rewrite).

Dependency: `@modelcontextprotocol/server`
Dependency: `@modelcontextprotocol/client`
Dependency: `@modelcontextprotocol/node`

## Decision

The monolithic `@modelcontextprotocol/sdk` (v1, protocol `2025-11-25`) is replaced by the SDK
v2 split packages, which are the official successors published from the same repository
(`github.com/modelcontextprotocol/typescript-sdk`, same npm maintainers):

- `@modelcontextprotocol/server` 2.3.1: `McpServer`, `Server`, the stdio server transport,
  `ProtocolError`, the spec types.
- `@modelcontextprotocol/client` 2.3.1: `Client`, the Streamable HTTP and stdio client
  transports used by the daemon's loopback forwarder and the harness scripts.
- `@modelcontextprotocol/node` 2.1.1: `NodeStreamableHTTPServerTransport`, the `node:http`
  adapter for the daemon's internal loopback MCP endpoint. v2 moved the Node Streamable HTTP
  server transport out of the server package; this is the official replacement for the v1
  `server/streamableHttp.js` import.

All three are build-time (devDependencies) and inlined into `dist/` by the build, as the v1
SDK was, so the published runtime graph (`scripts/release/runtime-graph.json`) is unchanged.

`zod-to-json-schema` moves from a transitive dependency of the v1 SDK to a direct
devDependency at the same locked version (3.25.1). The v1 SDK's `toJsonSchemaCompat` used it
to advertise the Zod 3 prototype spec schema; v2 removed that helper, and calling the
converter directly with the same options keeps `schemas/tool-definitions.json` unchanged.

## Alternatives checked

| Alternative                                                                                                                       | Why not                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stay on `@modelcontextprotocol/sdk` 1.x                                                                                           | It only speaks protocol `2025-11-25`; the Tasks extension (#4668) needs the 2026-07-28 surface that only v2 ships. The SDK team describes the monolith as retired in favour of the split packages. |
| `WebStandardStreamableHTTPServerTransport` from the server package plus a hand-written `node:http` to `Request`/`Response` bridge | Re-implements what the official Node adapter does; the adapter's own deps (`hono`, `@hono/node-server`) were already in the lock through the v1 SDK.                                               |
| An existing repository helper                                                                                                     | None: `src/` and `scripts/lib/` have no MCP protocol implementation.                                                                                                                               |
| Zod 4's built-in `toJSONSchema` for the prototype spec                                                                            | The spec schema is Zod 3; converting it with a different converter changes the advertised tool definition.                                                                                         |

## Consequences

- Wire output is unchanged. The v2 behaviour differences are bridged in code, each in one
  place: `McpError` (`src/daemon/mcpError.ts`) keeps the v1 `MCP error <code>: ` message prefix
  on errors this server throws; `createStdioServerTransport`
  (`src/server/stdioServerTransport.ts`) keeps the stdio transport open across stdin EOF so
  requests received before EOF are still answered (#11951, #12049), and reads stdin only while
  started, as v1 did; `createSdkMcpServer` (`src/server/sdkMcpServer.ts`) bridges the rest:
  - it keeps v2 from advertising `prompts.listChanged`. `tools.listChanged` and
    `resources.listChanged` are advertised under both SDKs (v1's `registerTool` merged the
    tools bit in too), so the `initialize` capabilities are identical;
  - it maps the `tools/call` validation errors the SDK raises itself back to v1: a malformed
    request answers `-32603` with the bare validation message (v2: `-32602 "Invalid
    tools/call request: …"`), and a malformed result keeps its `MCP error -32602: ` prefix;
  - it gives every handler a signal whose transport-close abort reason is an `AbortError`
    DOMException, as v1's was (v2 aborts with `SdkError(ConnectionClosed)`), so the
    `error.name === "AbortError"` checks in `src/` still match.

  `test/server/sdkMcpServerV1Wire.test.ts` pins these frames server side. Two differences
  remain and are intentional: JSON-RPC notification frames serialize their keys in a
  different order (`jsonrpc` first), which no JSON consumer observes; and a transport close
  aborts in-flight handlers after the server's `onclose` hooks run, where v1 aborted first.

- The daemon's loopback client (`LoopbackMcpClient`) maps SDK v2 client errors back to the v1
  shape (prefixed message, numeric timeout/connection-closed codes, the abort signal's own
  reason), so daemon socket frames are unchanged. The harness clients (`scripts/mcp-drive.ts`,
  `scripts/manual-test/proxy-session.ts`) do the same through `withV1ClientErrors`, so a
  request timeout is still reported as `-32001`.
- v2 requires Zod `^4.2.0` for schemas it converts itself. This repository still pins Zod
  3.25.76; no v2 code path converts our schemas, because `tools/list`, `tools/call` and the
  resource handlers remain our own `setRequestHandler` handlers. The v2 packages carry their
  own nested Zod 4 copy.
