import type { BootedDevice } from "../../models";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";

/** The simctl display key the iOS simulator observer uses for a single-screen simulator. */
export const WATCH_SIMCTL_DEFAULT_DISPLAY = "main";

/** The `simctl io screenshot --display=` key for a watch: its inventoried panel, else `main`. */
export function watchScreenshotDisplay(device: Pick<BootedDevice, "displays">): string {
  return device.displays?.panels[0]?.key ?? WATCH_SIMCTL_DEFAULT_DISPLAY;
}

/** Captures an Apple Watch simulator's screen as PNG bytes. */
export type WatchScreenshotCapture = (
  device: BootedDevice,
  signal?: AbortSignal,
) => Promise<Buffer>;

type WatchScreenshotSimctl = Pick<SimCtlClient, "screenshot">;

/** Through `simctl io screenshot` on the watch's display, the capture observe uses (#15986). */
export function captureWatchSimctlScreenshot(
  device: BootedDevice,
  signal?: AbortSignal,
  simctl: (device: BootedDevice) => WatchScreenshotSimctl = (target) => new SimCtlClient(target),
): Promise<Buffer> {
  return simctl(device).screenshot(device.deviceId, watchScreenshotDisplay(device), signal);
}
