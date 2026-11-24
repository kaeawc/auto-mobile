import { visionosPress } from "../features/visionos/VisionosGestures";
import type { BootedDevice } from "../models";
import { toActionableError } from "../models/ActionableError";
import { createStructuredToolResponse, throwIfAborted } from "../utils/toolUtils";
import type { ProgressCallback } from "./toolRegistry";

type HomeScreenHandler<Args, Response> = (
  device: BootedDevice,
  args: Args,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) => Promise<Response>;

/**
 * homeScreen on an Apple Vision Pro: the runner's XCUIDevice home press (the Digital Crown), the
 * same press as `pressButton home`. The window app runner cannot read the Home View, so the result
 * reports the press, not a verified home screen. Every other platform keeps `mobileHandler`.
 */
export function withVisionosHomeScreen<Args, Response>(
  mobileHandler: HomeScreenHandler<Args, Response>,
) {
  return async (
    device: BootedDevice,
    args: Args,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    if (device.platform !== "visionos") {
      return mobileHandler(device, args, progress, signal);
    }
    throwIfAborted(signal);
    try {
      await visionosPress(device.deviceId, "home", signal);
    } catch (error) {
      throwIfAborted(signal);
      throw toActionableError(error, "Failed to go to home screen");
    }
    return createStructuredToolResponse({
      message: "Pressed the Digital Crown (home)",
      success: true,
      navigationMethod: "hardware" as const,
    });
  };
}
