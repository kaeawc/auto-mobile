/**
 * Emits `notifications/tools/list_changed` to connected MCP clients so they
 * re-fetch `tools/list` after a runtime change that alters tool definitions —
 * either the advertised `outputSchema` or which tools are available. Injected
 * into {@link FeatureFlagService} so the notification stays fakeable in unit
 * tests and the feature-flag layer keeps no hard dependency on the MCP server /
 * `ToolRegistry`. The production wiring (in `createMcpServer`) delegates to
 * `ToolRegistry.notifyToolListChanged()`, which owns the server reference and the
 * best-effort emit — mirroring how `ResourceRegistry` emits `resources/list_changed`.
 * See issue #2963.
 *
 * Contract: implementations are best-effort and MUST NOT throw — a failed
 * notification must never break the flag toggle that triggered it.
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
