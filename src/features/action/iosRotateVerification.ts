import type { ObserveResult, RotateResult } from "../../models";
import { resolveIosObserveRotation } from "../observe/iosObserveRotation";

type Orientation = "portrait" | "landscape" | "unknown";

const IOS_ROTATION_UNSUPPORTED_ERROR =
  "Rotation is not supported on this display (the screen size did not change)";
const IOS_COVER_ROTATION_UNSUPPORTED_ERROR =
  "Rotation is not supported on the cover panel (the screen size did not change). Open the device to its inner panel (unfold the hinge) and retry there, or keep the current orientation.";

// Name the panel the way the cover refusal does, so an inner-panel refusal on a foldable
// does not read as an unnamed display (#17385). Other roles keep the generic wording.
function rotationTargetName(previousObservation: ObserveResult | undefined): string {
  return previousObservation?.display.role === "inner" ? "the inner panel" : "this display";
}

function unsupportedRotationError(previousObservation: ObserveResult | undefined): string {
  return `Rotation is not supported on ${rotationTargetName(previousObservation)} (the screen size did not change)`;
}

function unchangedSizeError(previousObservation: ObserveResult | undefined): string {
  return previousObservation?.display.role === "cover"
    ? IOS_COVER_ROTATION_UNSUPPORTED_ERROR
    : `${unsupportedRotationError(previousObservation)}. The runner reported a rotation but the screen size is unchanged.`;
}

function panelRefusalError(
  previousObservation: ObserveResult | undefined,
  runnerError: string | undefined,
): string | undefined {
  if (runnerError !== IOS_ROTATION_UNSUPPORTED_ERROR) {
    return undefined;
  }
  switch (previousObservation?.display.role) {
    case "cover":
      return IOS_COVER_ROTATION_UNSUPPORTED_ERROR;
    case "inner":
      return `${unsupportedRotationError(previousObservation)}. Keep the current orientation.`;
    default:
      return undefined;
  }
}

function verifyIosRunnerFailure(
  normalized: RotateResult,
  result: RotateResult,
  context: {
    requested: "portrait" | "landscape";
    previous: Orientation;
    current: Orientation;
    previousObservation: ObserveResult | undefined;
  },
): RotateResult {
  const { requested, previous, current, previousObservation } = context;
  const panelError = panelRefusalError(previousObservation, result.error);
  if (panelError) {
    return {
      ...normalized,
      success: false,
      rotationPerformed: false,
      error: panelError,
    };
  }
  if (current === requested && previous !== "unknown" && previous !== requested) {
    return {
      ...normalized,
      success: true,
      rotationPerformed: true,
      error: undefined,
      warning: `The runner reported "${result.error ?? "Failed to rotate iOS device"}" although the observed display changed from ${previous} to ${current}.`,
      message: `Successfully rotated from ${previous} to ${current}`,
    };
  }
  return normalized;
}

export function normalizeIosOrientation(orientation: string | undefined): Orientation {
  switch (orientation) {
    case "portrait":
    case "portrait_upside_down":
      return "portrait";
    case "landscape":
    case "landscape_left":
    case "landscape_right":
      return "landscape";
    default:
      return "unknown";
  }
}

export function observedIosOrientation(observation: ObserveResult | undefined): Orientation {
  if (!observation) {
    return "unknown";
  }
  // Observation rotation is already resolved from hierarchy evidence. Do not
  // reinterpret it using screenshot dimensions that may retain portrait axes.
  const rotation = observation.rotation;
  if (rotation === 0 || rotation === 2) {
    return "portrait";
  }
  if (rotation === 1 || rotation === 3) {
    return "landscape";
  }
  const fallback = resolveIosObserveRotation(undefined, observation.screenSize);
  return fallback === undefined ? "unknown" : fallback === 0 ? "portrait" : "landscape";
}

function rotationMismatchError(
  result: RotateResult,
  requested: "portrait" | "landscape",
  current: Orientation,
  previousObservation: ObserveResult | undefined,
): string {
  const claim = result.rotationPerformed
    ? `a completed rotation to ${requested}`
    : `the device was already in ${requested} orientation`;
  const unchangedSize = iosRotationScreenSizeUnchanged(previousObservation, result);
  const unsupported =
    result.rotationPerformed &&
    normalizeIosOrientation(result.previousOrientation) === "unknown" &&
    unchangedSize
      ? `${unsupportedRotationError(previousObservation)}. `
      : "";
  const error = `${unsupported}The display is still ${current} after the runner reported ${claim} (currentOrientation: ${result.currentOrientation ?? "unknown"}).`;
  return error;
}

function iosRotationScreenSizeUnchanged(
  previousObservation: ObserveResult | undefined,
  result: RotateResult,
): boolean {
  const beforeSize = previousObservation?.screenSize;
  const afterSize = result.observation?.screenSize;
  return (
    Boolean(
      sameIosDisplay(previousObservation, result.observation) &&
      beforeSize &&
      afterSize &&
      beforeSize.width === afterSize.width &&
      beforeSize.height === afterSize.height,
    ) === true
  );
}

function knownPositiveSize(observation: ObserveResult | undefined): boolean {
  return (observation?.screenSize.width ?? 0) > 0 && (observation?.screenSize.height ?? 0) > 0;
}

// Only a cross-axis rotation must change the screen size. A same-axis repair
// (the app already showed the requested axis but XCUIDevice still remembered
// the other one) legitimately keeps its dimensions and must stay a success.
function isUnverifiedIosRotationSize(
  result: RotateResult,
  requested: "portrait" | "landscape",
  observed: { previous: Orientation; current: Orientation },
  previousObservation: ObserveResult | undefined,
): boolean {
  const { previous, current } = observed;
  return (
    (((result.success && result.rotationPerformed) ||
      (!result.success && previous !== "unknown" && current === requested)) &&
      previous !== requested &&
      (current === requested || current === "unknown") &&
      knownPositiveSize(previousObservation) &&
      knownPositiveSize(result.observation) &&
      iosRotationScreenSizeUnchanged(previousObservation, result)) === true
  );
}

function isObservedRotationMismatch(
  result: RotateResult,
  requested: "portrait" | "landscape",
  current: Orientation,
): boolean {
  return result.success && current !== "unknown" && current !== requested;
}

// Two observations of different displays (different display keys) say nothing about whether
// one display's size changed; a missing key is no evidence of a different display.
function sameIosDisplay(
  before: ObserveResult | undefined,
  after: ObserveResult | undefined,
): boolean {
  const beforeKey = before?.display?.key;
  const afterKey = after?.display?.key;
  return beforeKey === undefined || afterKey === undefined || beforeKey === afterKey;
}

export function verifyIosRotation(
  result: RotateResult,
  requested: "portrait" | "landscape",
  previousObservation: ObserveResult | undefined,
): RotateResult {
  const previous = observedIosOrientation(previousObservation);
  const current = observedIosOrientation(result.observation);
  const normalized = {
    ...result,
    previousOrientation:
      previous === "unknown" ? normalizeIosOrientation(result.previousOrientation) : previous,
    currentOrientation:
      current === "unknown" ? normalizeIosOrientation(result.currentOrientation) : current,
  };
  if (isUnverifiedIosRotationSize(result, requested, { previous, current }, previousObservation)) {
    const error = unchangedSizeError(previousObservation);
    // The screen did not rotate, so the runner's orientation readout (the requested axis) is
    // transient: report the orientation the display still has, like the next observe (#17306).
    // Dimensions alone cannot name a landscape direction, so a missing held rotation clears the
    // runner's transient one rather than keeping the requested axis.
    const held = previous !== "unknown";
    return {
      ...normalized,
      currentOrientation: held ? previous : normalized.currentOrientation,
      ...(result.observation && held
        ? { observation: { ...result.observation, rotation: previousObservation?.rotation } }
        : {}),
      success: false,
      rotationPerformed: false,
      error,
      message: `Failed to rotate to ${requested}; the screen size did not change.`,
    };
  }
  if (isObservedRotationMismatch(result, requested, current)) {
    const error = rotationMismatchError(result, requested, current, previousObservation);
    return {
      ...normalized,
      success: false,
      rotationPerformed: false,
      error,
      message: `Failed to rotate to ${requested}; the display is still ${current}.`,
    };
  }
  if (!result.success) {
    return verifyIosRunnerFailure(normalized, result, {
      requested,
      previous,
      current,
      previousObservation,
    });
  }
  return {
    ...normalized,
    message: result.rotationPerformed
      ? `Successfully rotated from ${normalized.previousOrientation} to ${normalized.currentOrientation}`
      : `Device is already in ${normalized.currentOrientation} orientation`,
  };
}

export function restoreTargetIosOrientation(observation: ObserveResult | undefined): Orientation {
  const { width, height } = observation?.screenSize ?? { width: 0, height: 0 };
  // Duo inner panels can report a stale portrait rotation while drawn landscape (#17101).
  if (width > 0 && height > 0 && width !== height) {
    return width > height ? "landscape" : "portrait";
  }
  return observedIosOrientation(observation);
}
