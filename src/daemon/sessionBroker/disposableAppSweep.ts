import type { DisposableAppPlatform } from "../../features/prototype/disposableApp/disposableAppId";
import type { Timer } from "../../utils/SystemTimer";
import {
  combineAbortSignals,
  combineWithAmbientAbort,
  runWithAbortSignal,
} from "../../utils/AbortContext";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";

export interface DisposableAppExpirySweeper {
  sweepExpired(
    deviceId: string,
    platform: DisposableAppPlatform,
    reportRemoval: (appId: string) => void,
  ): Promise<void>;
}

function sweptPlatform(platform: string): DisposableAppPlatform | undefined {
  return platform === "android" || platform === "ios" ? platform : undefined;
}

/**
 * Removes expired disposable apps from a freshly acquired Android device or iOS simulator within
 * the preparation deadline. Only apps this host's registry recorded are candidates, so a physical
 * iPhone (where installs are refused) has none. Best effort: a failure is logged and never fails
 * session preparation.
 */
export async function sweepExpiredDisposableApps(
  sweeper: DisposableAppExpirySweeper | undefined,
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout" | "sleep">,
  device: { platform: string; transportId?: string | null },
  options: { signal?: AbortSignal; deadlineMs: number },
): Promise<string[]> {
  const platform = sweptPlatform(device.platform);
  const deviceId = platform ? (device.transportId ?? undefined) : undefined;
  const remainingMs = options.deadlineMs - timer.now();
  const inheritedSignal = combineWithAmbientAbort(options.signal);
  if (!sweeper || !platform || !deviceId || remainingMs <= 0 || inheritedSignal?.aborted) {
    return [];
  }
  const controller = new AbortController();
  const signal = combineAbortSignals(controller.signal, inheritedSignal);
  const removed: string[] = [];
  try {
    await raceWithDeadline(
      () =>
        runWithAbortSignal(signal, () =>
          sweeper.sweepExpired(deviceId, platform, (appId) => {
            removed.push(appId);
            logger.warn(`Removed expired disposable prototype app ${appId} from ${deviceId}`);
          }),
        ),
      {
        timer,
        signal: inheritedSignal,
        timeoutMs: remainingMs,
        label: "Disposable app expiry sweep",
        onTimeout: () => controller.abort(),
      },
    );
  } catch (error) {
    logger.warn(`Disposable app expiry sweep failed on ${deviceId}: ${errorMessage(error)}`, error);
  }
  return [...removed];
}
