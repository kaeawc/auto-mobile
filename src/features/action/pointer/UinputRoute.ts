import type { PointerEnvironment, PointerFeatures, PointerSupport } from "./PointerInjector";
import { DispatchingRoute, SUPPORTED, unsupported } from "./DispatchingRoute";

/**
 * A virtual pen registered through Android's `uinput` tool (#13105): stylus and eraser strokes with
 * pressure and stylus hover on emulators and rooted devices, where `/dev/uinput` is writable only by
 * root.
 * It is the last route, so a runner that injects without root is always preferred. Tilt,
 * orientation and barrel buttons are refused until their evdev mapping is verified on a device.
 */
export class UinputRoute extends DispatchingRoute {
  readonly route = "uinput" as const;
  supports(features: PointerFeatures, device: PointerEnvironment): PointerSupport {
    if (device.platform !== "android") {
      return unsupported("uinput injection is an Android route");
    }
    if (features.toolType !== "stylus" && features.toolType !== "eraser") {
      return unsupported("the uinput route injects a stylus or eraser only");
    }
    if (features.extendedAxes) {
      return unsupported(
        "the uinput route does not inject tilt, orientation and barrel buttons yet",
      );
    }
    if (device.rootShell !== true) {
      return unsupported(
        "uinput injection needs a root adb shell (run adb root on an emulator or userdebug build)",
      );
    }
    return SUPPORTED;
  }
}
