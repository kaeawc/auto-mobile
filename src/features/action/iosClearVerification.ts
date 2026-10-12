import { sequenceBackoff } from "../../utils/Backoff";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import type { FocusedTextField } from "./ClearText";
import type { TextActionResult } from "./SendKeys";
import { readIosTypedTextField, type IosTypedTextObserver } from "./iosTypedTextVerification";
import { getTextRequestDeadlineMs } from "./textTransportTimeout";

export const IOS_CLEAR_MAX_ATTEMPTS = 3;
const clearBackoff = sequenceBackoff([100, 200]);

function classifyClearField(field: FocusedTextField | undefined): TextActionResult | string {
  if (field?.secure) {
    return { success: true, warning: "iOS clear check skipped for a secure field." };
  }
  if (field?.value === undefined) {
    return {
      success: true,
      warning: "iOS clear was not verified: the focused field could not be read.",
    };
  }
  return field.value === "" ? { success: true } : field.value;
}

/** Verify an acknowledged clear; only the idempotent runner clear may be retried. */
export async function verifyIosClear({
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
  const read = async () => {
    requestSignal?.throwIfAborted();
    const field = await readIosTypedTextField(observer, timer, requestSignal, display, {
      iosEmptyAsBlank: true,
    });
    requestSignal?.throwIfAborted();
    return classifyClearField(field);
  };
  let remaining = await read();
  let attempts = 1;
  while (typeof remaining === "string" && attempts < IOS_CLEAR_MAX_ATTEMPTS) {
    requestSignal?.throwIfAborted();
    const delay = clearBackoff.delayForAttempt(attempts);
    const deadline = getTextRequestDeadlineMs();
    if (deadline !== undefined && deadline - timer.now() <= delay) {
      break;
    }
    await raceWithDeadline(() => timer.sleep(delay), {
      timer,
      signal: requestSignal,
      label: "iOS clear retry",
    });
    requestSignal?.throwIfAborted();
    const liveDeadline = getTextRequestDeadlineMs();
    if (liveDeadline !== undefined && liveDeadline <= timer.now()) {
      break;
    }
    const result = await clear();
    attempts++;
    if (!result.success) {
      return result;
    }
    const after = await read();
    if (after === remaining) {
      return {
        success: true,
        warning: `The field still holds ${JSON.stringify(after)} after the clear was acknowledged and retried; it may be a mask or permanent prefix at its cleared content, or the app may have refused the clear.`,
      };
    }
    remaining = after;
  }
  return typeof remaining === "string"
    ? {
        success: false,
        error: `iOS clear left text in the focused field after ${attempts} attempt(s); remaining value: ${JSON.stringify(remaining)}.`,
      }
    : remaining;
}
