import {
  HOVER_INPUT_CAPABILITY,
  STYLUS_INPUT_CAPABILITY,
} from "../../observe/android/ctrlProxyProtocol/capabilities";
import type { PointerEnvironment, PointerFeatures, PointerSupport } from "./PointerInjector";
import { POINTER_INSTRUMENTATION_MIN_SDK } from "./instrumentationDispatch";
import { DispatchingRoute, SUPPORTED, unsupported } from "./DispatchingRoute";

/**
 * `UiAutomation.injectInputEvent` from an instrumentation process: stylus contact (with variable
 * pressure) and stylus or mouse hover. Usable only when the runner advertises the matching
 * capability flag. Combinations that make no sense (a finger hover, hover with pressure, a mouse
 * click) never reach a route: {@link invalidPointerFeatures} rejects them first.
 */
export class InstrumentationRoute extends DispatchingRoute {
  readonly route = "instrumentation" as const;
  supports(features: PointerFeatures, device: PointerEnvironment): PointerSupport {
    if (device.platform !== "android") {
      return unsupported("instrumentation injection is an Android route");
    }
    if (features.toolType === "finger") {
      return unsupported("finger touches use the accessibility route");
    }
    if (features.toolType === "eraser") {
      return unsupported("the instrumentation runner does not inject an eraser");
    }
    const needed = features.hover ? HOVER_INPUT_CAPABILITY : STYLUS_INPUT_CAPABILITY;
    if (device.capabilities.has(needed)) {
      return SUPPORTED;
    }
    const old =
      device.apiLevel !== undefined && device.apiLevel < POINTER_INSTRUMENTATION_MIN_SDK
        ? `: this device runs Android API ${device.apiLevel} and the route needs Android 12 (API ${POINTER_INSTRUMENTATION_MIN_SDK})`
        : "";
    return unsupported(`the connected runner does not advertise ${needed}${old}`, needed);
  }
}
