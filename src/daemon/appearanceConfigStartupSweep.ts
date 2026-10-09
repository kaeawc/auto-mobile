import { pruneSessionAppearanceConfigs } from "../server/appearanceManager";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { RehydrationSummary } from "./sessionManager";

export interface AppearanceSweepSessions {
  getSession(sessionId: string): unknown;
}

/**
 * After startup rehydration, drop per-session appearance rows that name no live device session
 * (#11076). In-memory observers do not survive a restart, and journal-terminalized or pruned
 * sessions never ran the live release that clears their row. A row is kept for a session that is
 * live now or that rehydration left for a later recovery; a timed-out rehydration proves nothing
 * about the rows it never listed, so the sweep is skipped then.
 */
export async function sweepStaleAppearanceConfigs(
  summary: RehydrationSummary,
  sessions: AppearanceSweepSessions,
  prune: typeof pruneSessionAppearanceConfigs = pruneSessionAppearanceConfigs,
): Promise<string[]> {
  if (summary.timedOut) {
    logger.info("[Appearance] Startup rehydration timed out; keeping per-session appearance rows");
    return [];
  }
  const awaitingRecovery = new Set(
    summary.skipped
      .filter(({ reason }) => reason !== "not-recoverable")
      .map(({ sessionUuid }) => sessionUuid),
  );
  try {
    const dropped = await prune(
      (sessionId) => awaitingRecovery.has(sessionId) || isPresent(sessions.getSession(sessionId)),
    );
    if (dropped.length > 0) {
      logger.info(`[Appearance] Dropped ${dropped.length} stale per-session appearance rows`);
    }
    return dropped;
  } catch (error) {
    logger.warn(`[Appearance] Startup appearance-row sweep failed: ${errorMessage(error)}`, error);
    return [];
  }
}

function isPresent(session: unknown): boolean {
  return session !== null && session !== undefined;
}
