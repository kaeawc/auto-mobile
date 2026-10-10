import { logger } from "../utils/logger";
import {
  releasePlanSessionAndDevice,
  type ReleaseCutExecutions,
  type SessionReleaseManager,
  type SessionReleasePool,
} from "./releaseSessionAndDevice";
import type { SessionReleaseCallback } from "./sessionManager";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { executionTracker } from "../server/executionTracker";

/** The slice of the session manager the cascade needs. */
export interface DerivedLabelSessionSource extends SessionReleaseManager {
  getSession(sessionId: string): { assignedDevice: string } | null;
  takeDerivedLabelSessions(baseSessionId: string): string[];
  onSessionRelease(callback: SessionReleaseCallback): void;
}

export interface DerivedLabelSessionReleaseCascade {
  /** Settles once every cascade release started so far has finished. */
  settled(): Promise<void>;
}

/**
 * Releasing a base session (explicit release, heartbeat expiry, idle release, plan auto-release)
 * releases its derived `${base}:${label}` sessions with the plan auto-release reason (#11091).
 * Without it a derived session outlives its base: `afterExecution` finds no label map, the derived
 * session no longer resolves to a base, and it holds its device until reaped. Plan auto-release
 * frees the derived sessions first, so by the time it releases the base there is nothing left here.
 */
export function registerDerivedLabelSessionReleaseCascade(
  manager: DerivedLabelSessionSource,
  pool: SessionReleasePool,
  executions: ReleaseCutExecutions = executionTracker,
): DerivedLabelSessionReleaseCascade {
  const pending = new Set<Promise<void>>();

  const releaseDerived = async (baseSessionId: string, derivedSessionId: string): Promise<void> => {
    const session = manager.getSession(derivedSessionId);
    if (!session) {
      return;
    }
    try {
      // The derived session's own calls are cut before its device is freed (#11490). The call
      // whose lookup released the base, if any, is answered by that lookup and is spared.
      await releasePlanSessionAndDevice(
        manager,
        pool,
        {
          sessionId: derivedSessionId,
          baseSessionId,
          deviceId: session.assignedDevice,
          excludeExecutionId: getToolSelectionContext()?.execution?.executionId,
        },
        executions,
      );
      logger.info(
        `[DeviceLabelMap] Released label session ${derivedSessionId} with its base ${baseSessionId}`,
      );
    } catch (error) {
      logger.warn(
        `[DeviceLabelMap] Failed to release label session ${derivedSessionId} with its base ${baseSessionId}`,
        error,
      );
    }
  };

  manager.onSessionRelease((sessionId, _deviceId, _reason, _snapshot, options) => {
    // A terminal upgrade of an already-notified release has nothing new to cascade.
    if (options?.upgradeOnly) {
      return;
    }
    const derived = manager.takeDerivedLabelSessions(sessionId);
    if (derived.length === 0) {
      return;
    }
    // Start after the release callbacks return: a nested release must not run inside the
    // base's release notification.
    const cascade = Promise.resolve()
      .then(() => Promise.all(derived.map((id) => releaseDerived(sessionId, id))))
      .then(() => undefined);
    pending.add(cascade);
    void cascade.finally(() => pending.delete(cascade));
  });

  return {
    settled: async () => {
      while (pending.size > 0) {
        await Promise.all(pending);
      }
    },
  };
}
