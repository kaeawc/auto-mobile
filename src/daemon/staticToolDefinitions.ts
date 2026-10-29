import toolDefinitionsJson from "../../schemas/tool-definitions.json";
import type { ProxiedToolDefinition } from "./daemonMcpProxy";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { DaemonOptions } from "./types";
import { isAlwaysLoadToolsEnabled } from "../config/alwaysLoadTools";

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
 * flag-independent shape (name, title, annotations, description, inputSchema, `_meta`); the
 * post-connect reconciliation delivers the accurate list, `outputSchema`
 * included when the daemon advertises it (issue #5879 review).
 */
interface RawToolDefinition {
  name: string;
  title?: string;
  annotations?: ToolAnnotations;
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
const DEVICE_RESOURCE_BUDGET_META_KEY = "automobile/deviceResourceBudget";
const HOST_INVENTORY_META_KEY = "automobile/hostInventory";
const HOST_SIDE_STATE_META_KEY = "automobile/hostSideState";
const OPAQUE_PERSISTENT_STATE_META_KEY = "automobile/opaquePersistentState";

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
  const alwaysLoad = isAlwaysLoadToolsEnabled();
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
    delete meta[DEVICE_RESOURCE_BUDGET_META_KEY];
    delete meta[HOST_INVENTORY_META_KEY];
    delete meta[HOST_SIDE_STATE_META_KEY];
    delete meta[OPAQUE_PERSISTENT_STATE_META_KEY];
    const definition: ProxiedToolDefinition = {
      name: tool.name,
      title: tool.title,
      annotations: tool.annotations,
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

/**
 * Whether the advertised definition of `toolName` declares `property` as an input. Lets the CLI
 * and other processes that cannot load the registry derive tool behaviour from the generated
 * schema instead of keeping their own tool-name list (#11825).
 */
/**
 * Whether the committed definition of `toolName` carries the `deviceResourceBudget` trait
 * (`_meta["automobile/deviceResourceBudget"]`). The daemon's request-budget sizing reads the trait
 * here instead of a tool-name set (#15672); the flag is stripped from the cold wire payload.
 */
export function staticToolDeclaresDeviceResourceBudget(toolName: string): boolean {
  return (
    RAW_DEFINITIONS.find((tool) => tool.name === toolName)?._meta?.[
      DEVICE_RESOURCE_BUDGET_META_KEY
    ] === true
  );
}

/**
 * Whether the committed definition of `toolName` carries the `hostInventory` trait
 * (`_meta["automobile/hostInventory"]`). Socket admission and the proxy read it here instead of
 * their own tool-name lists (#15672); the flag is stripped from the cold wire payload.
 */
export function staticToolDeclaresHostInventory(toolName: unknown): boolean {
  return (
    typeof toolName === "string" &&
    RAW_DEFINITIONS.find((tool) => tool.name === toolName)?._meta?.[HOST_INVENTORY_META_KEY] ===
      true
  );
}

function staticToolDeclaresMeta(toolName: string, key: string): boolean {
  return RAW_DEFINITIONS.find((tool) => tool.name === toolName)?._meta?.[key] === true;
}

/**
 * Whether the committed definition of `toolName` carries the `changesHostSideState` trait
 * (`_meta["automobile/hostSideState"]`), read by the broker's Android reset policy instead of a
 * tool-name set (#15672); the flag is stripped from the cold wire payload.
 */
export function staticToolChangesHostSideState(toolName: string): boolean {
  return staticToolDeclaresMeta(toolName, HOST_SIDE_STATE_META_KEY);
}

/**
 * Whether the committed definition of `toolName` carries the `changesOpaquePersistentState` trait
 * (`_meta["automobile/opaquePersistentState"]`), read by the broker's Android reset policy instead of
 * a tool-name set (#15672); the flag is stripped from the cold wire payload.
 */
export function staticToolChangesOpaquePersistentState(toolName: string): boolean {
  return staticToolDeclaresMeta(toolName, OPAQUE_PERSISTENT_STATE_META_KEY);
}

export function staticToolDeclaresInput(toolName: string, property: string): boolean {
  const properties = RAW_DEFINITIONS.find((tool) => tool.name === toolName)?.inputSchema.properties;
  return typeof properties === "object" && properties !== null && property in properties;
}
