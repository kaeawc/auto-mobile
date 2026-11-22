import { ActionableError } from "../../models/ActionableError";
import type { WatchRunnerClient } from "./WatchRunnerClient";
import {
  getWatchRunnerLifecycle,
  unownedWatchRunnerMessage,
  type WatchRunnerLifecycle,
} from "./WatchRunnerLifecycle";
import { watchRunners } from "./WatchRunnerRegistry";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";

export type WatchRunnerRecoveryLifecycle = Pick<
  WatchRunnerLifecycle,
  "ownsRunner" | "restartOwned"
>;

/**
 * The registered watch runner, restarting a dropped lifecycle-owned one once first (#18822). A
 * runner AutoMobile did not start is refused rather than restarted; a failed restart is not retried.
 */
export async function requireWatchRunner(
  deviceId: string,
  signal?: AbortSignal,
  lifecycle: WatchRunnerRecoveryLifecycle = getWatchRunnerLifecycle(),
): Promise<WatchRunnerClient> {
  return (await acquireWatchRunner(deviceId, signal, lifecycle)).client;
}

async function acquireWatchRunner(
  deviceId: string,
  signal: AbortSignal | undefined,
  lifecycle: WatchRunnerRecoveryLifecycle,
): Promise<{ client: WatchRunnerClient; restarted: boolean }> {
  signal?.throwIfAborted();
  const registered = watchRunners.get(deviceId);
  if (registered?.isUsable()) {
    return { client: registered, restarted: false };
  }
  if (!lifecycle.ownsRunner(deviceId)) {
    if (registered) {
      throw new ActionableError(unownedWatchRunnerMessage(deviceId));
    }
    return { client: watchRunners.require(deviceId), restarted: false };
  }
  const failure = await lifecycle.restartOwned(deviceId, signal);
  signal?.throwIfAborted();
  const restarted = watchRunners.get(deviceId);
  if (failure !== undefined || !restarted?.isUsable()) {
    throw new ActionableError(
      `The watch runner for ${deviceId} disconnected and could not be restarted: ${failure ?? "the restart did not connect a usable runner"}. Call startDevice to restart the runner, then retry.`,
    );
  }
  return { client: restarted, restarted: true };
}

/**
 * Run a read against the watch runner. If the read fails because a runner that was not just
 * restarted dropped mid-request, restart it once and repeat the read once; any further failure
 * surfaces unchanged. Only idempotent reads belong here: a dropped tap may already have landed.
 */
export async function withWatchRunnerRead<T>(
  deviceId: string,
  read: (client: WatchRunnerClient) => Promise<T>,
  signal?: AbortSignal,
  lifecycle: WatchRunnerRecoveryLifecycle = getWatchRunnerLifecycle(),
): Promise<T> {
  const { client, restarted } = await acquireWatchRunner(deviceId, signal, lifecycle);
  try {
    return await read(client);
  } catch (error) {
    if (restarted || signal?.aborted || client.isUsable() || !lifecycle.ownsRunner(deviceId)) {
      throw error;
    }
    logger.warn(
      `[WatchRunner] Runner for ${deviceId} dropped during a read; restarting it once: ${errorMessage(error)}`,
      error,
    );
    return read(await requireWatchRunner(deviceId, signal, lifecycle));
  }
}
