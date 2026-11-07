import type { BootedDevice } from "../../models";
import { RealObserveScreen } from "../observe/ObserveScreen";

/** Reads the app on screen; undefined when the observation does not name one. */
export type ForegroundAppReader = (
  device: BootedDevice,
  signal?: AbortSignal,
) => Promise<string | undefined>;

/** A fresh hierarchy-only read of the foreground app, the same `activeWindow.appId` wcag checks. */
export const observeForegroundApp: ForegroundAppReader = async (device, signal) => {
  const result = await new RealObserveScreen(device).execute({
    freshness: "fresh",
    skipScreenshot: true,
    skipBackStack: true,
    skipAccessibilityAudit: true,
    skipPerformanceAudit: true,
    ...(signal ? { signal } : {}),
  });
  return result.activeWindow?.appId;
};
