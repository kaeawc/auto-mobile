import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { toActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { throwIfAborted } from "../../utils/toolUtils";
import { StaleDisplayError } from "../observe/StaleDisplayError";
import { resolveGestureCtrlProxyTimeoutMs } from "./gestureTransportTimeout";
import { throwIfLongPressInterrupted } from "./tapSharedHelpers";
import { assertTouchscreenInputSucceeded, inputDurationArgument } from "./touchscreenInput";

export interface AndroidLongPressOptions {
  adb: Pick<AdbExecutor, "executeCommand">;
  x: number;
  y: number;
  durationMs: number;
  signal?: AbortSignal;
  /** Throws when the display changed since the target was resolved. */
  assertCurrent?: () => void;
  /** Log prefix, e.g. the owning tool's class name. */
  logTag: string;
}

/**
 * Coordinate long press shared by tapOn and tapAny (#11832): touchscreen source first, generic
 * input source only after a non-cancellation failure. Both sources send the integer-rounded
 * duration Android's parser requires, size the transport timeout from the press duration, and
 * treat an `Error:`/`Usage:` output as a failure so the fallback is reachable.
 */
export async function dispatchAndroidLongPress(options: AndroidLongPressOptions): Promise<void> {
  const { adb, x, y, durationMs, signal, assertCurrent, logTag } = options;
  throwIfAborted(signal);
  const duration = inputDurationArgument(durationMs);
  const timeoutMs = resolveGestureCtrlProxyTimeoutMs(durationMs);
  const send = async (command: string): Promise<void> => {
    // Once beforeSend lands, also pass this as the dispatch's beforeSend.
    assertCurrent?.();
    const result = await adb.executeCommand(command, { timeoutMs, signal });
    assertTouchscreenInputSucceeded(command, result);
  };
  try {
    try {
      await send(`shell input touchscreen swipe ${x} ${y} ${x} ${y} ${duration}`);
    } catch (error) {
      logger.warn(`[${logTag}] touch input swipe failed: ${errorMessage(error)}`, error);
      throwIfLongPressInterrupted(error, durationMs, signal);
      if (error instanceof StaleDisplayError) {
        throw error;
      }
      throwIfAborted(signal);
      // Only a non-cancellation failure may use the legacy input source.
      await send(`shell input swipe ${x} ${y} ${x} ${y} ${duration}`);
    }
  } catch (error) {
    logger.warn(`[${logTag}] Android long press failed: ${errorMessage(error)}`, error);
    throwIfLongPressInterrupted(error, durationMs, signal);
    if (error instanceof StaleDisplayError) {
      throw error;
    }
    throw toActionableError(error, "Android long press failed");
  }
}
