import toolDefinitionsJson from "../../schemas/tool-definitions.json";
import type { ProxiedToolDefinition } from "./daemonMcpProxy";

/**
 * The committed, static MCP tool surface.
 *
 * `schemas/tool-definitions.json` is generated from the live {@link
 * ToolRegistry} (`scripts/generate-tool-definitions.ts`) and kept byte-for-byte
 * in sync with it by `test/server/toolRegistration.test.ts` ("committed
 * tool-definitions.json matches the live schemas in both directions"). It is the
 * full advertised surface — including plan/daemon-only tools (`barrier`,
 * `criticalSection`) that a stdio proxy process does not itself register — so it
 * is the correct source for advertising tools before any daemon connection
 * exists (issue #5879).
 */
interface RawToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

// Map once at module load. Callers treat the result as read-only (the proxy
// hands it straight to the MCP `tools/list` response), so a single array is
// shared across every proxy instance and request rather than re-mapped per call.
const STATIC_TOOL_DEFINITIONS: ProxiedToolDefinition[] = (
  toolDefinitionsJson as RawToolDefinition[]
).map((tool) => ({
  name: tool.name,
  ...(tool.description !== undefined ? { description: tool.description } : {}),
  inputSchema: tool.inputSchema,
  ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
}));

/**
 * The static tool surface served by `tools/list` before a daemon connection is
 * established. Returns the shared array; callers must not mutate it.
 */
export function getStaticToolDefinitions(): ProxiedToolDefinition[] {
  return STATIC_TOOL_DEFINITIONS;
}
