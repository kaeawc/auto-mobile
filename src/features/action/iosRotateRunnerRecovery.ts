import { IOSCtrlProxyClient } from "../observe/ios";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { ObserveResult, RotateResult } from "../../models";
import type { PerformanceTracker } from "../../utils/PerformanceTracker";
import {
  iosRotatePanel,
  requestIosRotate,
  restoreTargetIosOrientation,
} from "./iosRotateVerification";

export type IosRotateRunner = Pick<
  IOSCtrlProxyClient,
  "requestRotate" | "ensureRecoveryStarted" | "awaitRecovery"
>;

// The runner's refusal (FoldableRotateDecision.physicalDeviceError) for a foldable panel off the
// simulator: it sent nothing, so there is nothing to restore (#17047).
export const IOS_FOLDABLE_PANEL_SIMULATOR_ONLY_ERROR =
  "Rotating an iPhone Duo panel is only supported on the iOS Simulator; it has not been verified on a physical device.";

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

/**
 * A rotate the display could not honor (SpringBoard ignores landscape) still leaves the device
 * orientation changed, so the next app launches rotated. Put the prior orientation back.
 */
export async function restoreIosOrientationAfterFailure(
  failed: RotateResult,
  client: IosRotateRunner | undefined,
  previousObservation: ObserveResult | undefined,
  call: { perf: PerformanceTracker; signal?: AbortSignal },
): Promise<RotateResult> {
  const { perf, signal } = call;
  const prior = restoreTargetIosOrientation(previousObservation);
  if (
    !client ||
    prior === "unknown" ||
    prior === failed.orientation ||
    failed.error === IOS_FOLDABLE_PANEL_SIMULATOR_ONLY_ERROR
  ) {
    return failed;
  }
  try {
    throwIfAborted(signal);
    const restored = await perf.track("iOSRotationRestore", () =>
      awaitWhileRequestIsLive(
        requestIosRotate(client, prior, perf, iosRotatePanel(previousObservation)),
        signal,
      ),
    );
    if (restored.timedOut) {
      client.ensureRecoveryStarted();
      const recovery = await awaitIosRunnerRecovery(client, "rotate restore", signal);
      return { ...failed, warning: `${unrestoredIosOrientationWarning(prior)} ${recovery}` };
    }
    if (!restored.success) {
      throw new Error(restored.error ?? "runner reported failure");
    }
    return failed;
  } catch (error) {
    throwIfAborted(signal);
    logger.warn(`iOS rotation restore to ${prior} failed: ${errorMessage(error)}`, error);
    return { ...failed, warning: unrestoredIosOrientationWarning(prior) };
  }
}
