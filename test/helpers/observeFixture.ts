import { isViewHierarchyResult } from "../../src/models/ViewHierarchyResult";
import type { ViewHierarchyResult } from "../../src/models/ViewHierarchyResult";
import type { ObserveResult } from "../../src/models/ObserveResult";

/** Older captures predate `display` and `observationId`; every other required field is present. */
type CapturedObservation = Omit<ObserveResult, "display" | "observationId"> &
  Partial<Pick<ObserveResult, "display" | "observationId">>;

const DEFAULT_DISPLAY: ObserveResult["display"] = {
  key: "default",
  role: "unknown",
  posture: "unknown",
  generation: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Wire-boundary check for a captured observation: the required `ObserveResult` fields are present
 * with the right primitive shape and, when a hierarchy is attached, it passes
 * `isViewHierarchyResult`. Deeper node shapes are tolerated downstream, as in production.
 */
export function isCapturedObservation(value: unknown): value is CapturedObservation {
  return (
    isRecord(value) &&
    typeof value.updatedAt === "number" &&
    isRecord(value.screenSize) &&
    typeof value.screenSize.width === "number" &&
    typeof value.screenSize.height === "number" &&
    isRecord(value.systemInsets) &&
    (value.viewHierarchy === undefined || isViewHierarchyResult(value.viewHierarchy))
  );
}

/**
 * Validates a captured observation (imported JSON) and returns it typed, filling `display` and
 * `observationId` for captures that predate them. Throws when the capture is malformed.
 */
export function observeResultFromFixture(raw: unknown, label = "fixture"): ObserveResult {
  if (!isCapturedObservation(raw)) {
    throw new Error(`${label} is not a captured ObserveResult`);
  }
  return { display: DEFAULT_DISPLAY, observationId: `fixture-${label}`, ...raw };
}

/**
 * Validates a captured view hierarchy (imported JSON) and returns it typed. Captures carry shapes
 * the static JSON type cannot express (array bounds from older runners, an array root), so the
 * check is the same shallow wire-boundary one production applies. Throws when it is malformed.
 */
export function viewHierarchyFromFixture(raw: unknown, label = "fixture"): ViewHierarchyResult {
  if (!isViewHierarchyResult(raw)) {
    throw new Error(`${label} is not a captured ViewHierarchyResult`);
  }
  return raw;
}

/** Same as {@link observeResultFromFixture} for an observation stored as JSON text in a capture. */
export function observeResultFromJsonText(text: string, label = "fixture"): ObserveResult {
  return observeResultFromFixture(JSON.parse(text), label);
}

/** The fields every in-memory observation literal states; `display` and `observationId` are defaulted. */
type ObservationFields = Omit<ObserveResult, "display" | "observationId"> &
  Partial<Pick<ObserveResult, "display" | "observationId">>;

/** Typed builder for in-memory observation literals, defaulting the required identity fields. */
export function buildObserveResult(fields: ObservationFields): ObserveResult {
  return { display: DEFAULT_DISPLAY, observationId: "test-observation", ...fields };
}

/** An otherwise empty hierarchy whose `packageName` tells a test which capture it came from. */
export function markedHierarchy(marker: string): ViewHierarchyResult {
  return { hierarchy: {}, packageName: marker };
}
