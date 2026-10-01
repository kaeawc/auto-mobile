import { AndroidCtrlProxyManager } from "../../../ctrlProxy/CtrlProxyManager";
import type { BootedDevice } from "../../../models";
import type { Timer } from "../../../utils/SystemTimer";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { logger } from "../../../utils/logger";

export interface ObserveAccessibilityManager {
  isAccessibilityServiceHealthy(): Promise<boolean>;
  rebindIfUnhealthy(): Promise<boolean>;
  waitForAccessibilityServiceBinding(): Promise<"already-bound" | "recovered" | "unhealthy">;
}

export type ObserveAccessibilityManagerFactory = (
  device: BootedDevice,
) => ObserveAccessibilityManager;

export const defaultObserveAccessibilityManagerFactory: ObserveAccessibilityManagerFactory = (
  device,
) => AndroidCtrlProxyManager.getInstance(device);

/** Diagnose a rootless capture before changing service state. The manager owns rebind serialization. */
export async function recoverRootlessAccessibilityService(
  manager: ObserveAccessibilityManager,
  timer: Timer,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (timeoutMs <= 0 || signal?.aborted) {
    return false;
  }
  try {
    return await raceWithDeadline(
      async () => {
        if (await manager.isAccessibilityServiceHealthy()) {
          return false;
        }
        const rebound = await manager.rebindIfUnhealthy();
        if (rebound) {
          return manager.isAccessibilityServiceHealthy();
        }
        return (await manager.waitForAccessibilityServiceBinding()) !== "unhealthy";
      },
      { timer, timeoutMs, signal, label: "observe accessibility recovery" },
    );
  } catch (error) {
    logger.warn("[VIEW_HIERARCHY] Accessibility recovery did not complete", error);
    return false;
  }
}
