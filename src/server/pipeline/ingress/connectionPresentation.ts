import { serverConfig } from "../../../utils/ServerConfig";
import { logger } from "../../../utils/logger";
import type { ToolSelectionProfileRegistry } from "../../../daemon/toolSelectionProfileRegistry";

export function resolveToolResultsNoStructuredContent(
  registry: ToolSelectionProfileRegistry,
  connectionProfileUuid: string | undefined,
): boolean {
  const daemonDefault = serverConfig.isToolResultsNoStructuredContentEnabled();
  if (!connectionProfileUuid) {
    return daemonDefault;
  }
  try {
    return registry.getToolResultsNoStructuredContent(connectionProfileUuid) ?? daemonDefault;
  } catch (error) {
    // Presentation lookup is fail-safe: keep serving with the daemon default.
    logger.warn("[MCP] Could not resolve connection structured-content preference", {
      connectionProfileUuid,
      error,
    });
    return daemonDefault;
  }
}

export function rememberToolResultsNoStructuredContent(
  registry: ToolSelectionProfileRegistry,
  connectionProfileUuid: string | undefined,
  preference: boolean | undefined,
): void {
  if (!connectionProfileUuid || preference === undefined) {
    return;
  }
  try {
    registry.setToolResultsNoStructuredContent(connectionProfileUuid, preference);
  } catch (error) {
    // Presentation storage is best-effort: this request uses the daemon default.
    logger.warn("[MCP] Could not store connection structured-content preference", {
      connectionProfileUuid,
      error,
    });
  }
}

export function resolveActionsCompactMetadata(
  registry: ToolSelectionProfileRegistry,
  connectionProfileUuid: string | undefined,
): boolean {
  const daemonDefault = serverConfig.isActionsCompactMetadataEnabled();
  if (!connectionProfileUuid) {
    return daemonDefault;
  }
  try {
    return registry.getActionsCompactMetadata(connectionProfileUuid) ?? daemonDefault;
  } catch (error) {
    // Presentation lookup is fail-safe: keep serving with the daemon default.
    logger.warn("[MCP] Could not resolve connection compact-metadata preference", {
      connectionProfileUuid,
      error,
    });
    return daemonDefault;
  }
}

/**
 * Whether this connection's `tools/list` inlines the full prototype spec schema (#17723): the
 * daemon's own default, or the connection's request when it made one.
 */
export function resolvePrototypeFullSchema(
  registry: ToolSelectionProfileRegistry,
  connectionProfileUuid: string | undefined,
  daemonDefault: boolean,
): boolean {
  if (!connectionProfileUuid) {
    return daemonDefault;
  }
  try {
    return registry.getPrototypeFullSchema(connectionProfileUuid) ?? daemonDefault;
  } catch (error) {
    // Presentation lookup is fail-safe: keep serving with the daemon default.
    logger.warn("[MCP] Could not resolve connection prototype schema preference", {
      connectionProfileUuid,
      error,
    });
    return daemonDefault;
  }
}

export function rememberPrototypeFullSchema(
  registry: ToolSelectionProfileRegistry,
  connectionProfileUuid: string | undefined,
  preference: boolean | undefined,
): void {
  if (!connectionProfileUuid || preference === undefined) {
    return;
  }
  try {
    registry.setPrototypeFullSchema(connectionProfileUuid, preference);
  } catch (error) {
    // Presentation storage is best-effort: this connection lists the daemon default.
    logger.warn("[MCP] Could not store connection prototype schema preference", {
      connectionProfileUuid,
      error,
    });
  }
}

export function rememberActionsCompactMetadata(
  registry: ToolSelectionProfileRegistry,
  connectionProfileUuid: string | undefined,
  preference: boolean | undefined,
): void {
  if (!connectionProfileUuid || preference === undefined) {
    return;
  }
  try {
    registry.setActionsCompactMetadata(connectionProfileUuid, preference);
  } catch (error) {
    // Presentation storage is best-effort: this request uses the daemon default.
    logger.warn("[MCP] Could not store connection compact-metadata preference", {
      connectionProfileUuid,
      error,
    });
  }
}
