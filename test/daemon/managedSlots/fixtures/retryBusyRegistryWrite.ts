import { ManagedSlotDiscoveryIncompleteError } from "../../../../src/daemon/managedSlots/managedSlotRefusal";
import { RegistryRetryPacing } from "../../../../src/daemon/managedSlots/registryRetryPacing";
import { classifySqliteError } from "../../../../src/db/databaseFailureClassification";
import { defaultTimer, type Timer } from "../../../../src/utils/SystemTimer";

// The registry deliberately tries once at a 250 ms busy bound; callers re-drive.
// Cross-process tests must use that same pacing, not require first-attempt success (#12174).
const REGISTRY_WRITE_MAX_ATTEMPTS = 8;

export interface RetryBusyRegistryWriteOptions {
  timer?: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  maxAttempts?: number;
}

/** Result plus how many attempts it took (1 = landed first try). */
export async function retryBusyRegistryWrite<T>(
  operation: () => Promise<T>,
  options: RetryBusyRegistryWriteOptions = {},
): Promise<{ result: T; attempts: number }> {
  const timer = options.timer ?? defaultTimer;
  const maxAttempts = options.maxAttempts ?? REGISTRY_WRITE_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  const isBusy = (error: unknown) =>
    classifySqliteError(error) === "retryable" ||
    (error instanceof ManagedSlotDiscoveryIncompleteError && error.retryable);
  const startedMs = timer.now();
  let lastBusy: unknown;
  try {
    return { result: await operation(), attempts: 1 };
  } catch (error) {
    if (!isBusy(error)) {
      throw error;
    }
    lastBusy = error;
  }
  const pacing = new RegistryRetryPacing({ timer });
  try {
    pacing.noteBlocked(startedMs);
    for (let attempt = 1; attempt < maxAttempts; attempt++) {
      await pacing.wait(pacing.delay(attempt));
      const outcome = await pacing.run(
        async () => {
          try {
            return { succeeded: true as const, result: await operation() };
          } catch (error) {
            if (!isBusy(error)) {
              throw error;
            }
            return { succeeded: false as const, error };
          }
        },
        (value) => value.succeeded,
      );
      if (outcome.succeeded) {
        return { result: outcome.result, attempts: attempt + 1 };
      }
      lastBusy = outcome.error;
    }
    throw lastBusy;
  } finally {
    pacing.close();
  }
}
