import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import type { RequestCapabilitySource } from "../daemon/tasks/mcpTasksExtension";
import { isRecord } from "./pipeline/isRecord";
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

/** Only the advertised UI extension crosses the stdio proxy boundary. */
export function mcpAppsRequestMeta(capabilities: unknown): Record<string, unknown> | undefined {
  if (
    !clientAdvertisesMcpApps(capabilities) ||
    !isRecord(capabilities) ||
    !isRecord(capabilities.extensions)
  ) {
    return undefined;
  }
  return {
    [CLIENT_CAPABILITIES_META_KEY]: {
      extensions: { [MCP_APPS_EXTENSION_ID]: capabilities.extensions[MCP_APPS_EXTENSION_ID] },
    },
  };
}

/** Undefined means no request declaration: retain the connection's Apps decision. */
export function requestAdvertisesMcpApps(source: RequestCapabilitySource): boolean | undefined {
  for (const container of [source.envelope, source.meta]) {
    if (isRecord(container) && Object.hasOwn(container, CLIENT_CAPABILITIES_META_KEY)) {
      return clientAdvertisesMcpApps(container[CLIENT_CAPABILITIES_META_KEY]);
    }
  }
  return undefined;
}
