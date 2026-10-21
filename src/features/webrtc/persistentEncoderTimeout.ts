import type { Timer } from "../../utils/SystemTimer";
import { ActionableError } from "../../models";
import { logger } from "../../utils/logger";
interface PersistentEncoderTimeoutContext {
  timer: Timer;
}

/**
 * Race `operation` against a deadline driven by the injected `Timer`, so a
 * wedged ADB/USB state cannot block the persistent-encoder lifecycle forever.
 * On timeout the returned promise rejects with an `ActionableError`; launch-path
 * callers let it propagate (falling back to screenrecord) while teardown-path
 * callers catch it and continue. Deterministic under `FakeTimer` in tests.
 */
export function withTimeout<T>(
  context: Pick<PersistentEncoderTimeoutContext, "timer">,
  operation: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = context.timer.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      logger.warn(`[PersistentEncoderH264Source] ${label} timed out after ${ms}ms`);
      reject(new ActionableError(`${label} did not complete within ${ms}ms`));
    }, ms);
    operation.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        context.timer.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        context.timer.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
