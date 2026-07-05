import { logger } from "../utils/logger";

/**
 * The two MCP list-changed notification families AutoMobile emits at runtime
 * (issue #3223, follow-up to #2963). "tools" covers tool-definition changes
 * (outputSchema advertisement / availability after a feature-flag toggle);
 * "resources" covers resource registration changes.
 */
export type ListChangedKind = "tools" | "resources";

/**
 * MCP wire method for each list-changed kind. Shared by the daemon socket
 * broadcast (kind -> method) and the proxy's inbound dispatch (method -> kind)
 * so the two ends can never drift.
 */
export const LIST_CHANGED_NOTIFICATION_METHODS: Record<ListChangedKind, string> = {
  tools: "notifications/tools/list_changed",
  resources: "notifications/resources/list_changed",
};

/** Reverse lookup for {@link LIST_CHANGED_NOTIFICATION_METHODS}; undefined for unknown methods. */
export function listChangedKindForMethod(method: string): ListChangedKind | undefined {
  for (const [kind, wireMethod] of Object.entries(LIST_CHANGED_NOTIFICATION_METHODS)) {
    if (wireMethod === method) {
      return kind as ListChangedKind;
    }
  }
  return undefined;
}

export interface ListChangedListener {
  (kind: ListChangedKind): void;
}

/**
 * Process-wide fan-out for list-changed events, decoupled from any single MCP
 * server/transport (issue #3223). `ToolRegistry.notifyToolListChanged` and
 * `ResourceRegistry.notifyResourceListChanged` emit here in addition to their
 * per-session MCP notifications, and transport owners that are NOT MCP servers
 * (the daemon's Unix socket server, which pushes frames to connected
 * `DaemonMcpProxy` clients) subscribe. Emission is best-effort: a throwing
 * listener is logged and never breaks the runtime change that triggered it.
 */
class ListChangedBroadcasterClass {
  private readonly listeners = new Set<ListChangedListener>();

  /** Register a listener; returns an unsubscribe function. */
  subscribe(listener: ListChangedListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(kind: ListChangedKind): void {
    for (const listener of this.listeners) {
      try {
        listener(kind);
      } catch (error) {
        // Best-effort fan-out: one broken sink must not block the others or the
        // flag toggle / resource change that triggered the emit.
        logger.warn(`[ListChangedBroadcaster] listener failed for ${kind} list_changed: ${error}`);
      }
    }
  }

  /** Test-only: drop all listeners so suites sharing the singleton stay hermetic. */
  clearForTesting(): void {
    this.listeners.clear();
  }
}

// Singleton: one process-wide broadcast channel, mirroring ToolRegistry/ResourceRegistry.
export const ListChangedBroadcaster = new ListChangedBroadcasterClass();
