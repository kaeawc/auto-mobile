import {
  describePointerFeatures,
  isFingerOnly,
  type PointerEnvironment,
  type PointerFeatures,
  type PointerSupport,
} from "./PointerInjector";
import { DispatchingRoute, SUPPORTED, unsupported } from "./DispatchingRoute";

/** Today's path: CtrlProxy accessibility `dispatchGesture`. A finger touch and nothing else. */
export class CtrlProxyA11yRoute extends DispatchingRoute {
  readonly route = "ctrlproxy-a11y" as const;
  supports(features: PointerFeatures, environment: PointerEnvironment): PointerSupport {
    if (environment.platform !== "android") {
      return unsupported("accessibility gestures are an Android route");
    }
    return isFingerOnly(features)
      ? SUPPORTED
      : unsupported(
          `accessibility dispatchGesture only produces a finger touch, not ${describePointerFeatures(features)}`,
        );
  }
}
