import toolDefinitionsJson from "../../schemas/tool-definitions.json";
import type { ProxiedToolDefinition } from "./daemonMcpProxy";
import type { DaemonOptions } from "./types";

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
 * yields a clean actionable error. Once connected, plan-only definitions are
 * removed while externally callable static definitions remain available through
 * transient live-list filtering. This matches the issue's "show the tools, one
 * clear error on first use" intent without advertising plan-only calls forever.
 *
 * `outputSchema` is deliberately NOT advertised cold. Whether the daemon
 * suppresses it depends on the connection's `toolResultsNoStructuredContent`
 * preference and the daemon fallback, neither of which this proxy can resolve
 * before connecting. Advertising an output schema the
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
const DEBUG_ONLY_META_KEY = "automobile/debugOnly";
const EMBEDDED_SDK_ONLY_META_KEY = "automobile/embeddedSdkOnly";
const PLAN_ONLY_META_KEY = "automobile/planOnly";

function isConnectedFallbackAvailable(
  tool: RawToolDefinition,
  daemonOptions: DaemonOptions | undefined,
): boolean {
  const meta = tool._meta;
  return (
    meta?.[PLAN_ONLY_META_KEY] !== true &&
    (meta?.[DEBUG_ONLY_META_KEY] !== true || daemonOptions?.debug === true) &&
    (meta?.[EMBEDDED_SDK_ONLY_META_KEY] !== true || daemonOptions?.embeddedSdk === true)
  );
}

function toolDefinitions(
  connectedDaemonOptions: DaemonOptions | undefined | false,
): ProxiedToolDefinition[] {
  const alwaysLoad = process.env.AUTOMOBILE_ALWAYS_LOAD_TOOLS === "true";
  return RAW_DEFINITIONS.filter(
    (tool) =>
      connectedDaemonOptions === false ||
      isConnectedFallbackAvailable(tool, connectedDaemonOptions),
  ).map((tool) => {
    const meta: Record<string, unknown> = {
      ...(tool._meta ?? {}),
      ...(alwaysLoad ? { "anthropic/alwaysLoad": true } : {}),
    };
    delete meta[DEBUG_ONLY_META_KEY];
    delete meta[EMBEDDED_SDK_ONLY_META_KEY];
    delete meta[PLAN_ONLY_META_KEY];
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

/**
 * The static tool surface served by `tools/list` before a daemon connection is
 * established. `_meta` (e.g. the MCP Apps UI pointer, issue #4669) is preserved
 * verbatim, and `_meta["anthropic/alwaysLoad"]` is synthesized when
 * `AUTOMOBILE_ALWAYS_LOAD_TOOLS=true`, both matching
 * `ToolRegistry.getToolDefinitions()`. `outputSchema` is intentionally omitted
 * (see the file docstring).
 */
export function getStaticToolDefinitions(): ProxiedToolDefinition[] {
  return toolDefinitions(false);
}

/** Static schemas eligible to supplement a connected daemon's live tool list. */
export function getConnectedStaticToolDefinitions(
  daemonOptions?: DaemonOptions,
): ProxiedToolDefinition[] {
  return toolDefinitions(daemonOptions);
}
