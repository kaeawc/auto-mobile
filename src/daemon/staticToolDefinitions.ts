import toolDefinitionsJson from "../../schemas/tool-definitions.json";
import type { ProxiedToolDefinition } from "./daemonMcpProxy";

/**
 * The committed, static MCP tool surface.
 *
 * `schemas/tool-definitions.json` is generated from the live {@link
 * ToolRegistry} (`scripts/generate-tool-definitions.ts`) and kept byte-for-byte
 * in sync with it by `test/server/toolRegistration.integration.test.ts` ("committed
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
 *
 * `outputSchema` is deliberately NOT advertised cold. Whether the daemon
 * suppresses it depends on `toolResultsNoStructuredContent`, which can be set by
 * CLI, by persisted feature-flag DB state, or by a runtime toggle — none of
 * which this proxy can read without connecting. Advertising an output schema the
 * daemon may then strip from results would violate the MCP contract before the
 * client can call anything. The cold list therefore carries only the
 * flag-independent shape (name, description, inputSchema, `_meta`); the
 * post-connect reconciliation delivers the accurate list, `outputSchema`
 * included when the daemon advertises it (issue #5879 review).
 */
interface RawToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

// Parse once at module load; the per-call mapping below is cheap (tools/list is
// not a hot path) and must re-read the always-load env each call.
const RAW_DEFINITIONS: RawToolDefinition[] = toolDefinitionsJson as RawToolDefinition[];

/**
 * The static tool surface served by `tools/list` before a daemon connection is
 * established. `_meta` (e.g. the MCP Apps UI pointer, issue #4669) is preserved
 * verbatim, and `_meta["anthropic/alwaysLoad"]` is synthesized when
 * `AUTOMOBILE_ALWAYS_LOAD_TOOLS=true`, both matching
 * `ToolRegistry.getToolDefinitions()`. `outputSchema` is intentionally omitted
 * (see the file docstring).
 */
export function getStaticToolDefinitions(): ProxiedToolDefinition[] {
  const alwaysLoad = process.env.AUTOMOBILE_ALWAYS_LOAD_TOOLS === "true";
  return RAW_DEFINITIONS.map((tool) => {
    const meta: Record<string, unknown> = {
      ...(tool._meta ?? {}),
      ...(alwaysLoad ? { "anthropic/alwaysLoad": true } : {}),
    };
    const definition: ProxiedToolDefinition = {
      name: tool.name,
      inputSchema: tool.inputSchema,
    };
    if (tool.description !== undefined) {
      definition.description = tool.description;
    }
    if (Object.keys(meta).length > 0) {
      definition._meta = meta;
    }
    return definition;
  });
}
