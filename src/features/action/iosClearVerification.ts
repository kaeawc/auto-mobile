import { sequenceBackoff } from "../../utils/Backoff";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import type { FocusedTextField } from "./ClearText";
import type { TextActionResult } from "./SendKeys";
import { readIosTypedTextField, type IosTypedTextObserver } from "./iosTypedTextVerification";
import { getTextRequestDeadlineMs } from "./textTransportTimeout";
import { logger } from "../../utils/logger";

export const IOS_CLEAR_MAX_ATTEMPTS = 3;
const clearBackoff = sequenceBackoff([100, 200]);

function classifyClearField(
  field: FocusedTextField | undefined,
  lastValue?: string,
  attempts = 1,
  preClearValue?: string,
): TextActionResult | string {
  if (field?.secure) {
    return { success: true, warning: "iOS clear check skipped for a secure field." };
  }
  if (field?.value === undefined) {
    if (lastValue !== undefined) {
      return {
        success: false,
        partialApplication: true,
        error: `iOS clear could not be verified after ${attempts} attempt(s); the focused field last held ${JSON.stringify(lastValue)} and could not be read again.`,
      };
    }
    return {
      success: true,
      warning: "iOS clear was not verified: the focused field could not be read.",
    };
  }
  if (field.value === lastValue) {
    if (field.value !== "" && field.value === preClearValue) {
      return {
        success: false,
        error: `iOS clear removed nothing after ${attempts} attempt(s): the runner acknowledged each clear, but the focused field still holds its pre-clear value; remaining value: ${JSON.stringify(field.value)}.`,
      };
    }
    return {
      success: true,
      warning: `The field still holds ${JSON.stringify(field.value)} after the clear was acknowledged and retried; it may be a mask or permanent prefix at its cleared content, or the app may have refused the clear.`,
    };
  }
  return field.value === "" ? { success: true } : field.value;
}

/** Preserve the backoff admission check and re-check the live deadline after sleeping. */
async function waitForClearRetry(
  timer: Timer,
  attempts: number,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const delay = clearBackoff.delayForAttempt(attempts);
  const deadline = getTextRequestDeadlineMs();
  if (deadline !== undefined && deadline - timer.now() <= delay) {
    return false;
  }
  await raceWithDeadline(() => timer.sleep(delay), {
    timer,
    signal,
    label: "iOS clear retry",
  });
  signal?.throwIfAborted();
  const liveDeadline = getTextRequestDeadlineMs();
  return liveDeadline === undefined || liveDeadline > timer.now();
}

/** Read before clearing; only the idempotent runner clear may be retried. */
export async function clearIosFieldWithVerification({
  clear,
  observer,
  timer,
  signal,
  display,
}: {
  clear: () => Promise<TextActionResult>;
  observer: IosTypedTextObserver;
  timer: Timer;
  signal?: AbortSignal;
  display?: string;
}): Promise<TextActionResult> {
  const requestSignal = combineWithAmbientAbort(signal);
  const read = async (preClear = false) => {
    requestSignal?.throwIfAborted();
    const field = await readIosTypedTextField(observer, timer, requestSignal, display, {
      iosPlaceholderAsBlank: true,
    });
    requestSignal?.throwIfAborted();
    if (preClear && !field?.secure && field?.value === undefined) {
      logger.warn(
        "[iOS clear] Pre-clear field read unavailable; using post-clear verification only",
      );
    }
    return field;
  };
  const before = await read(true);
  const acknowledgement = await clear();
  if (!acknowledgement.success) {
    return acknowledgement;
  }
  requestSignal?.throwIfAborted();
  // Secure classification never reads the value, and needs no post-clear read.
  if (before?.secure) {
    return { success: true, warning: "iOS clear check skipped for a secure field." };
  }
  let remaining = classifyClearField(await read());
  let attempts = 1;
  while (typeof remaining === "string" && attempts < IOS_CLEAR_MAX_ATTEMPTS) {
    if (!(await waitForClearRetry(timer, attempts, requestSignal))) {
      break;
    }
    const result = await clear();
    attempts++;
    if (!result.success) {
      return { ...result, partialApplication: true };
    }
    remaining = classifyClearField(await read(), remaining, attempts, before?.value);
  }
  return typeof remaining === "string"
    ? {
        success: false,
        partialApplication: true,
        error: `iOS clear left text in the focused field after ${attempts} attempt(s); remaining value: ${JSON.stringify(remaining)}.`,
      }
    : remaining;
}
