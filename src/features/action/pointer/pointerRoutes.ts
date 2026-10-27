import {
  HOVER_INPUT_CAPABILITY,
  STYLUS_INPUT_CAPABILITY,
} from "../../observe/android/ctrlProxyProtocol/capabilities";
import { STYLUS_INPUT_MIN_SDK } from "../stylusPointer";
import {
  describePointerFeatures,
  isFingerOnly,
  type PointerEnvironment,
  type PointerFeatures,
  type PointerInjector,
  type PointerRequest,
  type PointerRouteId,
  type PointerSupport,
} from "./PointerInjector";

/** Performs the injection for one route; the real transports live beside their own routes. */
export type PointerDispatch = (request: PointerRequest, signal?: AbortSignal) => Promise<void>;

const SUPPORTED: PointerSupport = { supported: true };

function unsupported(reason: string, missingCapability?: string): PointerSupport {
  return missingCapability
    ? { supported: false, reason, missingCapability }
    : { supported: false, reason };
}

abstract class DispatchingRoute implements PointerInjector {
  abstract readonly route: PointerRouteId;
  constructor(private readonly dispatch: PointerDispatch) {}
  abstract supports(features: PointerFeatures, environment: PointerEnvironment): PointerSupport;
  inject(request: PointerRequest, signal?: AbortSignal): Promise<void> {
    return this.dispatch(request, signal);
  }
}

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

/**
 * `adb shell input stylus ...`: a stylus tap or swipe at the default pressure on Android 12 and
 * newer (earlier releases build the event without a stylus tool type). Pressure, hover and mouse
 * input are not expressible through the shell command.
 */
export class AdbInputSourceRoute extends DispatchingRoute {
  readonly route = "adb-input-source" as const;
  supports(features: PointerFeatures, environment: PointerEnvironment): PointerSupport {
    if (environment.platform !== "android" || features.toolType !== "stylus") {
      return unsupported("adb input stylus injects a stylus on Android only");
    }
    if (features.hover || features.variablePressure) {
      return unsupported(
        "adb input stylus injects constant-pressure strokes with contact; it cannot hover or vary pressure",
      );
    }
    if (environment.apiLevel === undefined) {
      return unsupported("the device's Android API level could not be read");
    }
    return environment.apiLevel >= STYLUS_INPUT_MIN_SDK
      ? SUPPORTED
      : unsupported(
          `adb input stylus needs Android API ${STYLUS_INPUT_MIN_SDK} or newer (this device reports API ${environment.apiLevel})`,
        );
  }
}

/**
 * `UiAutomation.injectInputEvent` from an instrumentation process: tool type, pressure and hover.
 * Usable only when the runner advertises the matching capability flag.
 */
export class InstrumentationRoute extends DispatchingRoute {
  readonly route = "instrumentation" as const;
  supports(features: PointerFeatures, environment: PointerEnvironment): PointerSupport {
    if (environment.platform !== "android") {
      return unsupported("instrumentation injection is an Android route");
    }
    if (features.toolType === "finger" && !features.hover) {
      return unsupported("a finger touch uses the faster accessibility route");
    }
    const needed = features.hover ? HOVER_INPUT_CAPABILITY : STYLUS_INPUT_CAPABILITY;
    if (!environment.capabilities.has(needed)) {
      return unsupported(`the connected runner does not advertise ${needed}`, needed);
    }
    if (features.hover && features.toolType === "stylus" && features.variablePressure) {
      return unsupported("hover has no contact, so it has no pressure");
    }
    if (features.variablePressure && !environment.capabilities.has(STYLUS_INPUT_CAPABILITY)) {
      return unsupported(
        `the connected runner does not advertise ${STYLUS_INPUT_CAPABILITY}`,
        STYLUS_INPUT_CAPABILITY,
      );
    }
    return SUPPORTED;
  }
}

/** The routes in preference order: the fast finger path first, then the shell, then instrumentation. */
export function defaultPointerRoutes(dispatches: {
  a11y: PointerDispatch;
  adbInputSource: PointerDispatch;
  instrumentation: PointerDispatch;
}): PointerInjector[] {
  return [
    new CtrlProxyA11yRoute(dispatches.a11y),
    new AdbInputSourceRoute(dispatches.adbInputSource),
    new InstrumentationRoute(dispatches.instrumentation),
  ];
}
