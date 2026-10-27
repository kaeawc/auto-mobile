import { STYLUS_INPUT_MIN_SDK } from "../stylusPointer";
import type { PointerEnvironment, PointerFeatures, PointerSupport } from "./PointerInjector";
import { DispatchingRoute, SUPPORTED, unsupported } from "./DispatchingRoute";

/**
 * `adb shell input stylus ...`: a stylus tap or swipe at the default pressure on Android 12 and
 * newer (earlier releases build the event without a stylus tool type). Pressure, hover and mouse
 * input are not expressible through the shell command.
 */
export class AdbInputSourceRoute extends DispatchingRoute {
  readonly route = "adb-input-source" as const;
  supports(features: PointerFeatures, device: PointerEnvironment): PointerSupport {
    if (device.platform !== "android" || features.toolType !== "stylus") {
      return unsupported("adb input stylus injects a stylus on Android only");
    }
    if (features.hover || features.variablePressure) {
      return unsupported(
        "adb input stylus injects constant-pressure strokes with contact; it cannot hover or vary pressure",
      );
    }
    if (device.apiLevel === undefined) {
      return unsupported("the device's Android API level could not be read");
    }
    return device.apiLevel >= STYLUS_INPUT_MIN_SDK
      ? SUPPORTED
      : unsupported(
          `adb input stylus needs Android API ${STYLUS_INPUT_MIN_SDK} or newer (this device reports API ${device.apiLevel})`,
        );
  }
}
