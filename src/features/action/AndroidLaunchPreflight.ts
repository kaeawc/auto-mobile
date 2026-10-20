import type { Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
const ANDROID_PREFLIGHT_ABORT_SETTLEMENT_GRACE_MS = 1_000;

export async function waitForAndroidPreflight<T>(
  preflight: Promise<T>,
  signal: AbortSignal | undefined,
  timer: Timer,
): Promise<T> {
  if (!signal) {
    return await preflight;
  }
  try {
    signal.throwIfAborted();
    return await raceWithDeadline(preflight, {
      timer: timer,
      signal,
      label: "Android preflight",
      relabelDefaultAbort: false,
    });
  } catch (error) {
    await awaitAndroidPreflightSettlement(preflight, timer);
    throw error;
  }
}

async function awaitAndroidPreflightSettlement(
  preflight: Promise<unknown>,
  timer: Timer,
): Promise<void> {
  const timeout = new Error("Android preflight settlement grace expired");
  try {
    await raceWithDeadline(
      preflight.then(
        () => undefined,
        () => undefined,
      ),
      {
        timer: timer,
        timeoutMs: ANDROID_PREFLIGHT_ABORT_SETTLEMENT_GRACE_MS,
        label: "Android preflight settlement",
        timeoutError: () => timeout,
      },
    );
  } catch (error) {
    if (error !== timeout) {
      throw error;
    }
  }
}
