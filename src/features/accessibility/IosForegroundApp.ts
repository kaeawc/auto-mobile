import type { BootedDevice } from "../../models";
import { RealObserveScreen } from "../observe/ObserveScreen";
import { usableForegroundAppId } from "../observe/observationVerdict";

/** Reads the app on screen; undefined when the observation does not name one or is unverified. */
export type ForegroundAppReader = (
  device: BootedDevice,
  signal?: AbortSignal,
) => Promise<string | undefined>;

/**
 * A fresh hierarchy-only read of the foreground app. An identity the observation could not verify
 * (a stale cached tree, the runner's SpringBoard fallback) is unknown, not a mismatch: refusing on
 * it would reject the app actually on screen, and the runner's own error still catches a real one.
 */
export const observeForegroundApp: ForegroundAppReader = async (device, signal) => {
  const result = await new RealObserveScreen(device).execute({
    freshness: "fresh",
    skipScreenshot: true,
    skipBackStack: true,
    skipAccessibilityAudit: true,
    skipPerformanceAudit: true,
    ...(signal ? { signal } : {}),
  });
  return usableForegroundAppId(result);
};
