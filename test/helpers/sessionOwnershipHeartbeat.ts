import { SingleFlightInterval } from "../../src/daemon/SingleFlightInterval";
import {
  DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
  DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE,
} from "../../src/daemon/types";
import type { IdGenerator } from "../../src/utils/IdGenerator";
import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";

const DEFAULT_STOP_TIMEOUT_MS = 5_000;

export interface SessionOwnershipHeartbeat {
  assertHealthy(): void;
  stop(): Promise<Error | null>;
}

export interface SessionOwnershipHeartbeatOptions {
  intervalMs: number;
  renew(signal: AbortSignal): Promise<void>;
  timer?: Timer;
  stopTimeoutMs?: number;
}

/**
 * Wraps a keeper renewal so its ownership claim is attempted once. The daemon
 * can accept a later token-only renewal when the session is still unowned, but
 * a response lost after a successful claim must not let a retry take ownership
 * back from a newer owner.
 */
export function createSingleClaimSessionOwnershipRenewal(
  renew: (claimLivenessOwnership: boolean, signal: AbortSignal) => Promise<void>,
): (signal: AbortSignal) => Promise<void> {
  let claimLivenessOwnership = true;

  return async (signal) => {
    const shouldClaimLivenessOwnership = claimLivenessOwnership;
    // Mark the attempt before awaiting: a daemon may apply a request whose
    // client-side response is subsequently lost.
    claimLivenessOwnership = false;
    await renew(shouldClaimLivenessOwnership, signal);
  };
}

export function isLivenessOwnerSuperseded(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE
  );
}

export function isLivenessOwnerConflict(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === DAEMON_LIVENESS_OWNER_CONFLICT_CODE
  );
}

/**
 * One-shot CLI clients displace this keeper, then stop heartbeating on exit.
 * Restore ownership in the same tick with a fresh token: repeating a displaced
 * token's claim is an idempotent no-op. Attempt only one re-claim per tick and
 * propagate its failure; lost claim responses and other errors are not retried.
 *
 * A re-claim the daemon rejects as `liveness_owner_conflict` means a CLI
 * invocation is still running with a live lease (#10050). That is not a failure:
 * the tick is skipped and the next one re-claims once that CLI has handed the
 * session back to the one-shot policy or its lease has lapsed.
 */
export function createReclaimingSessionOwnershipRenewal(
  renew: (
    livenessOwnerToken: string,
    claimLivenessOwnership: boolean,
    signal: AbortSignal,
  ) => Promise<void>,
  idGenerator: IdGenerator,
): (signal: AbortSignal) => Promise<void> {
  let livenessOwnerToken = idGenerator.next();
  const renewCurrentOwner = createSingleClaimSessionOwnershipRenewal((claim, signal) =>
    renew(livenessOwnerToken, claim, signal),
  );

  return async (signal) => {
    try {
      await renewCurrentOwner(signal);
    } catch (error) {
      if (!isLivenessOwnerSuperseded(error)) {
        throw error;
      }
      // The old token cannot take ownership back; a fresh claim protects the
      // session between CLI invocations without waiting for the next interval.
      livenessOwnerToken = idGenerator.next();
      try {
        await renew(livenessOwnerToken, true, signal);
      } catch (reclaimError) {
        if (!isLivenessOwnerConflict(reclaimError)) {
          throw reclaimError;
        }
      }
    }
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Keeps a session held by a sequence of one-shot CLI clients alive. Each CLI
 * process tears down its proxy heartbeat on exit, so long integration setup and
 * recording work must renew through the daemon's public heartbeat command.
 */
export async function startSessionOwnershipHeartbeat(
  options: SessionOwnershipHeartbeatOptions,
): Promise<SessionOwnershipHeartbeat> {
  const timer = options.timer ?? defaultTimer;
  let stopped = false;
  let failure: Error | null = null;
  let activeAbortController: AbortController | null = null;

  const heartbeat = new SingleFlightInterval(
    timer,
    options.intervalMs,
    async () => {
      if (stopped) {
        return;
      }
      const controller = new AbortController();
      activeAbortController = controller;
      try {
        await options.renew(controller.signal);
      } catch (error) {
        if (!stopped && !controller.signal.aborted) {
          failure ??= asError(error);
        }
        throw error;
      } finally {
        if (activeAbortController === controller) {
          activeAbortController = null;
        }
      }
    },
    {
      stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      onError: () => {},
    },
  );

  try {
    await heartbeat.run();
  } catch (error) {
    await heartbeat.stop();
    throw asError(error);
  }
  heartbeat.start();

  return {
    assertHealthy(): void {
      if (failure) {
        throw new Error(`session ownership heartbeat failed: ${failure.message}`, {
          cause: failure,
        });
      }
    },
    async stop(): Promise<Error | null> {
      stopped = true;
      activeAbortController?.abort();
      const settled = await heartbeat.stop();
      if (failure) {
        return failure;
      }
      return settled
        ? null
        : new Error("session ownership heartbeat did not settle before cleanup timeout");
    },
  };
}
