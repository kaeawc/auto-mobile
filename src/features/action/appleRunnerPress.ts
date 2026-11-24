import type { BootedDevice, PressButtonResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { tvosPress, unsupportedTvosAction } from "../tvos/TvosActions";
import { visionosPress } from "../visionos/VisionosGestures";
import { watchPress, unsupportedWatchAction } from "../watch/WatchActions";

/** The tvOS, watchOS and visionOS runner presses; undefined when the device has no such runner. */
export function pressOnAppleRunner(
  device: BootedDevice,
  button: string,
  { steps, signal, durationMs }: { steps?: number; signal?: AbortSignal; durationMs?: number },
): Promise<PressButtonResult> | undefined {
  switch (device.platform) {
    case "tvos":
      if (steps !== undefined) {
        unsupportedTvosAction("remote press with steps");
      }
      return tvosPress(device.deviceId, button, signal, durationMs);
    case "watchos":
      if (steps !== undefined) {
        unsupportedWatchAction("home with steps");
      }
      return watchPress(device.deviceId, button, signal);
    case "visionos":
      if (steps !== undefined) {
        throw new ActionableError("visionOS pressButton home does not take steps.");
      }
      return visionosPress(device.deviceId, button, signal);
    default:
      return undefined;
  }
}
