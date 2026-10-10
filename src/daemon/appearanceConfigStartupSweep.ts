import { pruneSessionAppearanceConfigs } from "../server/appearanceManager";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { DeviceSession } from "../db/types";
import type { RehydrationSummary } from "./sessionManager";

export interface AppearanceSweepSessions {
  getSession(sessionId: string): unknown;
}

/**
 * What the sweep needs to tell a live peer daemon's session from a stale one when several daemons
 * share a data dir (#11158). `liveDaemonSessionIds` is the startup live-peer set; by the time the
 * sweep runs, startup already expired every active `device_sessions` row owned by a dead daemon.
 */
export interface AppearanceSweepPeers {
  liveDaemonSessionIds: ReadonlySet<string>;
  ownDaemonSessionId: string;
  getPersistedSession(
    sessionUuid: string,
  ): Promise<Pick<DeviceSession, "status" | "daemon_session_id"> | undefined>;
}

/**
 * After startup rehydration, drop per-session appearance rows that name no live device session
 * (#11076). In-memory observers do not survive a restart, and journal-terminalized or pruned
 * sessions never ran the live release that clears their row. A row is kept for a session that is
 * live now or that rehydration left for a later recovery; a timed-out rehydration proves nothing
 * about the rows it never listed, so the sweep is skipped then.
 *
 * Rows are shared by every daemon on the data dir (#11158), so a row this daemon does not own is
 * dropped only when its session is terminal. A still-active persisted session belongs to a live
 * peer (dead owners were expired at startup) and is kept. A row naming no persisted session (an
 * observer, or a pruned session) is dropped only when no peer daemon is live, since a live peer's
 * observer rows are indistinguishable from stale ones.
 */
export async function sweepStaleAppearanceConfigs(
  summary: RehydrationSummary,
  sessions: AppearanceSweepSessions,
  peers: AppearanceSweepPeers,
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
    const hasLivePeer = [...peers.liveDaemonSessionIds].some(
      (id) => id !== peers.ownDaemonSessionId,
    );
    const dropped = await prune(
      async (sessionId) =>
        awaitingRecovery.has(sessionId) ||
        isPresent(sessions.getSession(sessionId)) ||
        (await mayBelongToLivePeer(sessionId, peers, hasLivePeer)),
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

async function mayBelongToLivePeer(
  sessionId: string,
  peers: AppearanceSweepPeers,
  hasLivePeer: boolean,
): Promise<boolean> {
  try {
    const persisted = await peers.getPersistedSession(sessionId);
    if (persisted === undefined) {
      return hasLivePeer;
    }
    return persisted.status === "active";
  } catch (error) {
    // Keeping a row we cannot classify is safe; dropping a live peer's row is not.
    logger.warn(
      `[Appearance] Could not read session ${sessionId} during startup sweep; keeping its row: ${errorMessage(error)}`,
      error,
    );
    return true;
  }
}

function isPresent(session: unknown): boolean {
  return session !== null && session !== undefined;
}
