import { tvosPress } from "../features/tvos/TvosActions";
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
 * homeScreen on an Apple TV (#17525): the runner's XCUIRemote home press, the same press as
 * `pressButton home`. tvOS has no launcher hierarchy to verify, so the result reports the press,
 * not a verified home screen. Every other platform keeps `mobileHandler`.
 */
export function withTvosHomeScreen<Args, Response>(
  mobileHandler: HomeScreenHandler<Args, Response>,
) {
  return async (
    device: BootedDevice,
    args: Args,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    if (device.platform !== "tvos") {
      return mobileHandler(device, args, progress, signal);
    }
    throwIfAborted(signal);
    try {
      await tvosPress(device.deviceId, "home", signal);
    } catch (error) {
      throwIfAborted(signal);
      throw toActionableError(error, "Failed to go to home screen");
    }
    return createStructuredToolResponse({
      message: "Pressed the Siri Remote home button",
      success: true,
      navigationMethod: "hardware" as const,
    });
  };
}
