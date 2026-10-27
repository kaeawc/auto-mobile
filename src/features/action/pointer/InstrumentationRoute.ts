import {
  HOVER_INPUT_CAPABILITY,
  STYLUS_INPUT_CAPABILITY,
} from "../../observe/android/ctrlProxyProtocol/capabilities";
import type { PointerEnvironment, PointerFeatures, PointerSupport } from "./PointerInjector";
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
    const needed = features.hover ? HOVER_INPUT_CAPABILITY : STYLUS_INPUT_CAPABILITY;
    return device.capabilities.has(needed)
      ? SUPPORTED
      : unsupported(`the connected runner does not advertise ${needed}`, needed);
  }
}
