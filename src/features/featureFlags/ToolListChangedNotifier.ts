import { logger } from "../../utils/logger";

/**
 * Emits `notifications/tools/list_changed` to connected MCP clients so they
 * re-fetch `tools/list` after a runtime change that alters tool definitions —
 * either the advertised `outputSchema` or which tools are available. Injected
 * into {@link FeatureFlagService} so the notification stays fakeable in unit
 * tests and the feature-flag layer keeps no hard dependency on the MCP server.
 * See issue #2963.
 */
export interface ToolListChangedNotifier {
  notifyToolListChanged(): void;
}

/**
 * Default used until the MCP server is wired in (and in unit tests that do not
 * care about the notification). Emitting when there is nothing to notify would
 * be meaningless, so this deliberately does nothing.
 */
export class NoopToolListChangedNotifier implements ToolListChangedNotifier {
  notifyToolListChanged(): void {
    // No server/transport to notify — intentionally a no-op.
  }
}

/**
 * Minimal surface of the MCP server needed to broadcast the notification. The
 * SDK's `McpServer` satisfies this. Kept narrow so the concrete notifier is
 * testable without constructing a full server (YAGNI).
 */
export interface ToolListChangeBroadcaster {
  sendToolListChanged(): void;
}

/**
 * Production notifier backed by the MCP server. The SDK's `sendToolListChanged()`
 * is itself a guarded no-op when no client is connected, so calling it before a
 * transport attaches (e.g. during startup CLI flag overrides) is safe.
 */
export class McpServerToolListChangedNotifier implements ToolListChangedNotifier {
  constructor(private readonly server: ToolListChangeBroadcaster) {}

  notifyToolListChanged(): void {
    try {
      this.server.sendToolListChanged();
    } catch (error) {
      // Best-effort: a failed tools/list_changed notification must never break a
      // flag toggle. Expected transient (e.g. transport mid-teardown), so debug.
      logger.debug(`Failed to send tools/list_changed notification: ${error}`);
    }
  }
}
