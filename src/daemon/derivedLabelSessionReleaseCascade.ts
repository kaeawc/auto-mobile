import { logger } from "../utils/logger";
import { isTerminalReleaseReason, type SessionReleaseReason } from "./releaseReasons";
import {
  cancelExecutionsCutBySessionRelease,
  releasePlanSessionAndDevice,
  releaseSessionAndDevice,
  type ReleaseCutExecutions,
  type SessionReleaseCut,
  type SessionReleaseManager,
  type SessionReleasePool,
} from "./releaseSessionAndDevice";
import type { SessionReleaseCallback } from "./sessionManager";
import { SessionReleasedDuringCallError } from "./sessionReleasedDuringCall";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { executionTracker } from "./executionTracker";

/** The slice of the session manager the cascade needs. */
export interface DerivedLabelSessionSource extends SessionReleaseManager {
  getSession(sessionId: string): { assignedDevice: string } | null;
  takeDerivedLabelSessions(baseSessionId: string, releaseReason?: string): string[];
  onSessionRelease(callback: SessionReleaseCallback): void;
}

export interface DerivedLabelSessionReleaseCascade {
  /** Settles once every cascade release started so far has finished. */
  settled(): Promise<void>;
}

/**
 * Releasing a base session releases its derived `${base}:${label}` sessions (#11091). Without it
 * a derived session outlives its base: `afterExecution` finds no label map, the derived session no
 * longer resolves to a base, and it holds its device until reaped.
 *
 * The base's end ends its labels (#11640): a base that ended for a terminal reason (explicit
 * release, idle expiry, heartbeat lapse, owner disconnect, device loss) ends each live label with
 * that same reason, so the label's own release reports it and a call still running under the label
 * gets the terminal refusal naming the label. A base released for a reason that leaves its UUID
 * usable (a handoff, a plan's own cleanup) releases its labels with the plan auto-release reason,
 * as before. Plan auto-release frees the derived sessions first, so by the time it releases the
 * base there is nothing left here.
 */
export function registerDerivedLabelSessionReleaseCascade(
  manager: DerivedLabelSessionSource,
  pool: SessionReleasePool,
  executions: ReleaseCutExecutions = executionTracker,
): DerivedLabelSessionReleaseCascade {
  const pending = new Set<Promise<void>>();

  /** End a label with its base's terminal reason: cut its calls typed, then free its device. */
  const endWithBase = async (
    cut: SessionReleaseCut & { deviceId: string },
    reason: SessionReleaseReason,
  ): Promise<void> => {
    cancelExecutionsCutBySessionRelease(
      executions,
      cut,
      new SessionReleasedDuringCallError(cut.sessionId, reason),
    ).catch((error: unknown) => {
      logger.warn(`[DeviceLabelMap] Failed to cancel executions of ${cut.sessionId}`, error);
    });
    await releaseSessionAndDevice(manager, pool, cut.deviceId, cut.sessionId, {
      reason,
    });
  };

  const releaseDerived = async (
    baseSessionId: string,
    derivedSessionId: string,
    baseReleaseReason: string,
  ): Promise<void> => {
    const session = manager.getSession(derivedSessionId);
    if (!session) {
      return;
    }
    // The derived session's own calls are cut before its device is freed (#11490). The call
    // whose lookup released the base, if any, is answered by that lookup and is spared.
    const cut = {
      sessionId: derivedSessionId,
      baseSessionId,
      deviceId: session.assignedDevice,
      excludeExecutionId: getToolSelectionContext()?.execution?.executionId,
    };
    try {
      if (isTerminalReleaseReason(baseReleaseReason)) {
        await endWithBase(cut, baseReleaseReason);
      } else {
        await releasePlanSessionAndDevice(manager, pool, cut, executions);
      }
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

  manager.onSessionRelease((sessionId, _deviceId, reason, _snapshot, options) => {
    // A terminal upgrade of an already-notified release has nothing new to cascade.
    if (options?.upgradeOnly) {
      return;
    }
    const derived = manager.takeDerivedLabelSessions(sessionId, reason);
    if (derived.length === 0) {
      return;
    }
    // Start after the release callbacks return: a nested release must not run inside the
    // base's release notification.
    const cascade = Promise.resolve()
      .then(() => Promise.all(derived.map((id) => releaseDerived(sessionId, id, reason))))
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
