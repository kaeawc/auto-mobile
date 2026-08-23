import { logger } from "../utils/logger";
import type { SessionReleaseSnapshot } from "../daemon/sessionManager";

/**
 * MCP-style wire method for the daemon's "a session was released" push
 * (issue #4610). Unlike the list-changed families there is only one method, so
 * this is a single named constant rather than a kind↔method map. Shared by the
 * daemon socket broadcast (emit → frame) and the proxy's inbound dispatch
 * (frame → clear bound binding) so the two ends can never drift.
 */
export const SESSION_RELEASED_NOTIFICATION_METHOD = "notifications/session/released";

export interface SessionReleaseListener {
  (sessionId: string, reason?: string, snapshot?: SessionReleaseSnapshot): void;
}

/**
 * Process-wide fan-out for session-release events, decoupled from any single
 * MCP server/transport (issue #4610). The daemon's centralized release callback
 * (`SessionManager.onSessionRelease`) emits every released session key here —
 * base and derived `${base}:${label}` alike — and the Unix socket server
 * subscribes so it can push a `notifications/session/released` frame to
 * connected `DaemonMcpProxy` clients. That lets a proxy clear a remembered
 * session binding the moment the daemon actually releases it (heartbeat / idle /
 * plan), instead of guessing with the replay TTL. Emission is best-effort: a
 * throwing listener is logged and never breaks the release that triggered it.
 *
 * Mirrors {@link ListChangedBroadcaster} in `listChangedBroadcast.ts`.
 */
class SessionReleaseBroadcasterClass {
  private readonly listeners = new Set<SessionReleaseListener>();

  /** Register a listener; returns an unsubscribe function. */
  subscribe(listener: SessionReleaseListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(sessionId: string, reason?: string, snapshot?: SessionReleaseSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId, reason, snapshot);
      } catch (error) {
        // Best-effort fan-out: one broken sink must not block the others or the
        // session release that triggered the emit.
        logger.warn(
          `[SessionReleaseBroadcaster] listener failed for released ${sessionId}: ${error}`,
        );
      }
    }
  }

  /** Test-only: drop all listeners so suites sharing the singleton stay hermetic. */
  clearForTesting(): void {
    this.listeners.clear();
  }
}

// Singleton: one process-wide broadcast channel, mirroring ListChangedBroadcaster.
export const SessionReleaseBroadcaster = new SessionReleaseBroadcasterClass();
