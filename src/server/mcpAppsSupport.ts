import { MCP_APP_MIME_TYPE } from "./observeAppResource";

/** The MCP Apps extension id a client lists under `capabilities.extensions` (spec 2026-01-26). */
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";

/**
 * Whether a client's `initialize` capabilities advertise MCP Apps rendering: the extension is
 * present and, when it names `mimeTypes`, lists the App profile. A client that says nothing, or
 * only lists other extensions, is not an Apps host and gets exactly what it got before.
 */
export function clientAdvertisesMcpApps(capabilities: unknown): boolean {
  const extensions = (capabilities as { extensions?: unknown } | null | undefined)?.extensions;
  if (typeof extensions !== "object" || extensions === null) {
    return false;
  }
  const entry = (extensions as Record<string, unknown>)[MCP_APPS_EXTENSION_ID];
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const mimeTypes = (entry as { mimeTypes?: unknown }).mimeTypes;
  return !Array.isArray(mimeTypes) || mimeTypes.includes(MCP_APP_MIME_TYPE);
}
