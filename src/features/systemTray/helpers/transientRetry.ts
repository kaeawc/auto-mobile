/** Bounded retry of a clearAll step that fails only because the host is loaded. */

import { AdbCommandTimeoutError } from "../../../utils/android-cmdline-tools/AdbCommandTimeoutError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { throwIfAborted } from "../../../utils/toolUtils";
import { NotificationShadeNotOpenError } from "../systemTrayNotificationList";
import { TransientPreSwipeError } from "../TransientPreSwipeError";
import { getSystemTrayDependencies } from "./dependencies";
import { sleep } from "./runtime";

/** Attempts a pre-swipe step gets in total, each with the caller's full awaitTimeout. */
export const SYSTEM_TRAY_PRE_SWIPE_ATTEMPTS = 3;

const isAdbTimeout = (error: unknown): boolean =>
  error instanceof AdbCommandTimeoutError ||
  (error instanceof Error && error.cause instanceof AdbCommandTimeoutError);

/**
 * Failures that say the device was slow, not that the request is wrong. Cancellation, device
 * errors and the deterministic custom-layout refusal are not among them.
 */
export const isTransientPreSwipeFailure = (error: unknown): boolean =>
  error instanceof TransientPreSwipeError ||
  error instanceof NotificationShadeNotOpenError ||
  isAdbTimeout(error);

/**
 * Run `step`, retrying a transient failure after the injected backoff, up to
 * SYSTEM_TRAY_PRE_SWIPE_ATTEMPTS attempts. The last failure is rethrown unchanged.
 */
export const retryTransientPreSwipe = async <T>(
  step: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  const { backoff } = getSystemTrayDependencies();
  let attempt = 1;
  while (true) {
    try {
      return await run();
    } catch (error) {
      throwIfAborted(signal);
      if (attempt >= SYSTEM_TRAY_PRE_SWIPE_ATTEMPTS || !isTransientPreSwipeFailure(error)) {
        throw error;
      }
      logger.warn(
        `[systemTray] ${step} failed transiently (attempt ${attempt}/${SYSTEM_TRAY_PRE_SWIPE_ATTEMPTS}): ${errorMessage(error)}; retrying`,
        error,
      );
    }
    await sleep(backoff.delayForAttempt(attempt), signal);
    attempt++;
  }
};
