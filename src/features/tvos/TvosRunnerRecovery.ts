import { tvosRunners } from "./TvosRunnerRegistry";
import { getTvosRunnerLifecycle, type TvosRunnerLifecycle } from "./TvosRunnerLifecycle";
import { ActionableError } from "../../models/ActionableError";

export async function requireTvosRunner(
  deviceId: string,
  signal?: AbortSignal,
  lifecycle?: Pick<TvosRunnerLifecycle, "restartOwned">,
) {
  signal?.throwIfAborted();
  if (!tvosRunners.get(deviceId)?.isUsable()) {
    const result = await (lifecycle ?? getTvosRunnerLifecycle()).restartOwned(deviceId, signal);
    signal?.throwIfAborted();
    if (result.unownedRunner) {
      return result.unownedRunner;
    }
    if (result.runnerUnavailable || !tvosRunners.get(deviceId)?.isUsable()) {
      throw new ActionableError(
        `tvOS runner unavailable for ${deviceId}: ${result.runnerUnavailable ?? "recovery did not connect a usable runner"}. Call startDevice to restart the runner, then retry.`,
      );
    }
  }
  return tvosRunners.require(deviceId);
}
