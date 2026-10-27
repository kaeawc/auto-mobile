/**
 * Pointer injection routes (#13098, follow-up 3 of the #12539 spike in
 * `docs/design-docs/mcp/stylus-pressure-hover-injection.md`).
 *
 * Accessibility `dispatchGesture` can only produce a finger touch, so a stylus or a hover must go
 * through another route. Each route says, from the device's facts, whether it can honour a set of
 * {@link PointerFeatures}; {@link selectPointerRoute} picks one, and a request no route can honour is
 * refused before anything is sent. Nothing ever degrades to a finger touch.
 */

export type PointerRouteId =
  | "ctrlproxy-a11y"
  | "adb-input-source"
  | "instrumentation"
  | "uinput"
  | "emulator-grpc";

export type PointerToolType = "finger" | "stylus" | "mouse";

/** What a request needs from the injector. */
export interface PointerFeatures {
  toolType: PointerToolType;
  /** A pressure other than the default 1.0. */
  variablePressure?: boolean;
  /** Hover enter, move and exit with no contact. */
  hover?: boolean;
}

/** The device facts a route decides on. */
export interface PointerEnvironment {
  platform: "android" | "ios";
  /** Android API level, when it could be read. */
  apiLevel?: number;
  /** CtrlProxy capability flags from the handshake (`stylus_input_v1`, `hover_input_v1`, ...). */
  capabilities: ReadonlySet<string>;
}

export type PointerSupport =
  | { supported: true }
  | {
      supported: false;
      reason: string;
      /** The CtrlProxy capability whose absence made this route unusable, when that was the cause. */
      missingCapability?: string;
    };

export interface PointerPoint {
  x: number;
  y: number;
  /** Milliseconds spent moving here from the previous point. */
  durationMs?: number;
  /** Hover distance from the surface, when the route can express it. */
  distance?: number;
}

export interface PointerRequest {
  features: PointerFeatures;
  points: readonly PointerPoint[];
  displayId?: number;
}

export interface PointerInjector {
  readonly route: PointerRouteId;
  supports(features: PointerFeatures, device: PointerEnvironment): PointerSupport;
  inject(request: PointerRequest, signal?: AbortSignal): Promise<void>;
}

/** True for the plain finger touch every device already supports. */
export function isFingerOnly(features: PointerFeatures): boolean {
  return (
    features.toolType === "finger" && features.hover !== true && features.variablePressure !== true
  );
}

export function describePointerFeatures(features: PointerFeatures): string {
  const parts: string[] = [features.toolType];
  if (features.hover) {
    parts.push("hover");
  }
  if (features.variablePressure) {
    parts.push("variable pressure");
  }
  return parts.join(" ");
}

/**
 * Why [features] can never be injected whatever the device, or undefined. Rejected once, before any
 * route is asked, so a contradictory request is never blamed on a missing capability: a finger or a
 * mouse has no pressure to vary, hover has no contact and so no pressure, a finger does not hover,
 * and a mouse is only supported hovering.
 */
export function invalidPointerFeatures(features: PointerFeatures): string | undefined {
  if (features.hover && features.toolType === "finger") {
    return "a finger does not hover; hover comes from a stylus or a mouse";
  }
  if (features.hover && features.variablePressure) {
    return "hover has no contact, so it has no pressure";
  }
  if (features.variablePressure && features.toolType !== "stylus") {
    return `${features.toolType} input has no variable pressure; only a stylus does`;
  }
  if (features.toolType === "mouse" && !features.hover) {
    return "mouse input is supported for hover only";
  }
  return undefined;
}
