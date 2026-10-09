import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";

/** Something a stream server can subscribe to for "this observer identity is gone" events. */
export interface ObserverReleaseSource {
  subscribe(listener: (sessionId: string) => void): () => void;
}

/**
 * Process-wide fan-out for observer registrations that ended for good: an explicit release or a
 * heartbeat timeout, never a promotion to a device session (#11076). Stream servers that admitted
 * an observer (video relay, WebRTC, observation stream) re-check or revoke its subscriptions, so a
 * viewer stream never outlives the registration that authorized it. Mirrors
 * `SessionReleaseBroadcaster`; emission is best-effort and a throwing listener never blocks others.
 */
class ObserverReleaseBroadcasterClass implements ObserverReleaseSource {
  private readonly listeners = new Set<(sessionId: string) => void>();

  subscribe(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(sessionId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId);
      } catch (error) {
        // Best-effort fan-out: one broken stream server must not keep the others streaming.
        logger.warn(
          `[ObserverReleaseBroadcaster] listener failed for observer ${sessionId}: ${errorMessage(error)}`,
          error,
        );
      }
    }
  }

  /** Test-only: drop all listeners so suites sharing the singleton stay hermetic. */
  clearForTesting(): void {
    this.listeners.clear();
  }
}

export const ObserverReleaseBroadcaster = new ObserverReleaseBroadcasterClass();
