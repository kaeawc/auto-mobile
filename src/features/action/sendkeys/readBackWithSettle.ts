import { fixedBackoff } from "../../../utils/Backoff";
import type { Timer } from "../../../utils/SystemTimer";
import {
  ANDROID_READ_BACK_ATTEMPTS,
  IME_COMMIT_READ_BACK_SETTLE_MS,
} from "./AndroidTypingConstants";

interface ReadBackOptions<T, R> {
  /** Synchronous continuation so callers can return this promise without another async wrapper. */
  finish(value: T | undefined, accepted: boolean): R;
  timer: Timer;
  /** Outside the read's catch boundary, after any settle sleep. */
  beforeRead?(): void;
  /** An expected unavailable read stops polling. Sleep/abort failures still propagate. */
  onReadError?(error: unknown): void;
}

/** Read immediately, then settle between mismatches; finish with the accepted or final value. */
export async function readBackWithSettle<T, R>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  options: ReadBackOptions<T, R>,
): Promise<R> {
  const backoff = fixedBackoff(IME_COMMIT_READ_BACK_SETTLE_MS);
  let value: T | undefined;
  for (let attempt = 0; attempt < ANDROID_READ_BACK_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await options.timer.sleep(backoff.delayForAttempt(attempt));
    }
    options.beforeRead?.();
    let accepted: boolean;
    try {
      value = await read();
      accepted = accept(value);
    } catch (error) {
      if (!options.onReadError) {
        throw error;
      }
      // The host logs expected unavailable reads and preserves its cancellation policy.
      options.onReadError(error);
      return options.finish(undefined, false);
    }
    if (accepted) {
      return options.finish(value, true);
    }
  }
  return options.finish(value, false);
}
