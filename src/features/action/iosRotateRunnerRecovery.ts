import { IOSCtrlProxyClient } from "../observe/ios";
import { throwIfAborted } from "../../utils/toolUtils";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";

export type IosRotateRunner = Pick<
  IOSCtrlProxyClient,
  "requestRotate" | "ensureRecoveryStarted" | "awaitRecovery"
>;

export const unrestoredIosOrientationWarning = (prior: string): string =>
  `The device orientation could not be restored to ${prior} after the failed rotate; the next app may open rotated.`;

/** Wait for an already-started runner recovery; cancellation still throws. */
export async function awaitIosRunnerRecovery(
  runner: IosRotateRunner,
  command: "rotate" | "rotate restore",
  signal?: AbortSignal,
): Promise<string> {
  let warning: string;
  try {
    const state = await runner.awaitRecovery(IOSCtrlProxyClient.OBSERVE_RECOVERY_WAIT_MS, signal);
    warning = `iOS runner recovery after ${command} timeout: ${state}${state === "recovered" ? " (runner restarted)" : ""}.`;
  } catch (error) {
    throwIfAborted(signal);
    logger.warn(`iOS ${command} timeout recovery failed: ${errorMessage(error)}`, error);
    warning = `iOS runner recovery after ${command} timeout: failed; ${errorMessage(error)}`;
  }
  // awaitRecovery reports an aborted wait as "timed_out"; surface the cancellation instead.
  throwIfAborted(signal);
  return warning;
}
