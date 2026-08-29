import toolDefinitionsJson from "../../schemas/tool-definitions.json";
import { serverConfig } from "../utils/ServerConfig";
import type { ProxiedToolDefinition } from "./daemonMcpProxy";

/**
 * The committed, static MCP tool surface.
 *
 * `schemas/tool-definitions.json` is generated from the live {@link
 * ToolRegistry} (`scripts/generate-tool-definitions.ts`) and kept byte-for-byte
 * in sync with it by `test/server/toolRegistration.test.ts` ("committed
 * tool-definitions.json matches the live schemas in both directions").
 *
 * It is generated with `includeUnavailable: true`, so it is a strict SUPERSET of
 * the runtime `tools/list` surface: it never omits a tool the daemon would serve
 * (feature-flag state lives in the daemon's DB, which this proxy process cannot
 * read, so a subset would risk hiding a live tool — the exact failure #5879
 * fixes). It over-advertises plan-only tools (`barrier`, `criticalSection`) and
 * flag-gated tools that a given daemon may not serve; calling one before connect
 * yields a clean actionable error, and the reconciliation `tools/list_changed`
 * (see `DaemonMcpProxy.doConnect`) narrows the client to the accurate list once
 * connected. This matches the issue's "show the tools, one clear error on first
 * use" intent.
 */
interface RawToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

// Parse once at module load; the per-call mapping below is cheap (tools/list is
// not a hot path) and must re-read the structured-content flag each call.
const RAW_DEFINITIONS: RawToolDefinition[] = toolDefinitionsJson as RawToolDefinition[];

/**
 * The static tool surface served by `tools/list` before a daemon connection is
 * established.
 *
 * `outputSchema` is dropped when `toolResultsNoStructuredContent` is enabled,
 * mirroring `ToolRegistry.getToolDefinitions()`: a server that advertises an
 * output schema is expected to return matching `structuredContent`, which that
 * flag strips (issue #2899). The flag is reuse-critical, so the proxy's value
 * matches the daemon it will connect to. `_meta` (e.g. the MCP Apps UI pointer,
 * issue #4669) is preserved verbatim.
 */
export function getStaticToolDefinitions(): ProxiedToolDefinition[] {
  const suppressOutputSchema = serverConfig.isToolResultsNoStructuredContentEnabled();
  return RAW_DEFINITIONS.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema !== undefined && !suppressOutputSchema
      ? { outputSchema: tool.outputSchema }
      : {}),
    ...(tool._meta !== undefined ? { _meta: tool._meta } : {}),
  }));
}
