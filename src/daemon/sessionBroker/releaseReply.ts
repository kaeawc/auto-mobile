import type { SessionBrokerReleaseResult } from "../../devices/sessionBrokerResult";
import { ActionableError } from "../../models/ActionableError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";

/** Allow normal native destruction under the CLI's 240 s deadline; proxies request less. */
export const SESSION_BROKER_RELEASE_REPLY_BUDGET_MS = 30_000;

export interface TrackedRelease {
  pending: Promise<SessionBrokerReleaseResult>;
  committed: Promise<unknown>;
}

interface ReleaseReplyOptions {
  releaseReplyBudgetMs?: number;
  timer?: Pick<Timer, "setTimeout" | "clearTimeout">;
}

/** Keep full native work owned and handle failures even after every RPC waiter has left. */
export function trackRelease(
  releases: Map<string, TrackedRelease>,
  sessionUuid: string,
  pending: Promise<SessionBrokerReleaseResult>,
  committed: Promise<unknown>,
): TrackedRelease {
  const tracked = { pending, committed };
  releases.set(sessionUuid, tracked);
  void pending.then(
    () => releases.delete(sessionUuid),
    (error: unknown) => {
      releases.delete(sessionUuid);
      logger.warn(`Session ${sessionUuid} release failed: ${errorMessage(error)}`, error);
    },
  );
  return tracked;
}

export function resolveReleaseReplyBudgetMs(
  replyBudgetMs?: number,
  configuredBudgetMs?: number,
): number {
  return replyBudgetMs !== undefined && Number.isFinite(replyBudgetMs)
    ? Math.max(0, Math.min(replyBudgetMs, SESSION_BROKER_RELEASE_REPLY_BUDGET_MS))
    : (configuredBudgetMs ?? SESSION_BROKER_RELEASE_REPLY_BUDGET_MS);
}

export async function boundedReleaseReply(
  sessionUuid: string,
  release: TrackedRelease,
  replyBudgetMs: number | undefined,
  options: ReleaseReplyOptions,
): Promise<SessionBrokerReleaseResult> {
  // A reply must never acknowledge ownership that the database has not committed.
  await release.committed;
  const timeout = new ActionableError("Session release reply budget elapsed");
  try {
    return await raceWithDeadline(release.pending, {
      timer: options.timer ?? defaultTimer,
      timeoutMs: resolveReleaseReplyBudgetMs(replyBudgetMs, options.releaseReplyBudgetMs),
      label: `Release session ${sessionUuid}`,
      timeoutError: () => timeout,
    });
  } catch (error) {
    if (error === timeout) {
      return { sessionUuid, outcome: "cleanup_pending" };
    }
    // trackRelease logs the failure; preserve the caller's original rejection contract.
    throw error;
  }
}
