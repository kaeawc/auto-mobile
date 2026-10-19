import type { ObserveResult } from "../models/ObserveResult";
import {
  diffObserveResult,
  isSameObservationScreen,
} from "../features/observe/output/ObserveResultOutput";
import type { ObservationDiffScreenIdentity } from "./finalizeToolResponse";
import type { ObservationActionClass } from "../features/action/observationActionClass";

/**
 * A value is treated as an `ObserveResult` for sanitization purposes when it is
 * an object carrying observe-specific fields. Hierarchy collection can fail
 * while the rest of observe still completes, so `viewHierarchy` is only one
 * marker; debug-perf fields on hierarchy-less observations must still be
 * stripped at the wire boundary.
 */
const OBSERVE_RESULT_MARKERS: ReadonlyArray<string> = [
  "updatedAt",
  "screenSize",
  "systemInsets",
  "viewHierarchy",
  "rawViewHierarchy",
  "elements",
  "perfTiming",
  "perfTimingTruncated",
  "gfxMetrics",
  "performanceAudit",
  "accessibilityAudit",
  "freshness",
];

export function isObserveResult(value: unknown): value is ObserveResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return OBSERVE_RESULT_MARKERS.some((key) => key in record);
}

export function hasRenderableHierarchy(observation: ObserveResult): boolean {
  return !!observation.viewHierarchy?.hierarchy;
}

export function hasScreenChangedEffect(payload: Record<string, unknown>): boolean {
  const effect = payload.effect;
  return (
    effect !== null &&
    typeof effect === "object" &&
    (effect as Record<string, unknown>).screenChanged === true
  );
}

/**
 * Owner decision on #11637 item 2: a diff always ships beside its `skeleton`
 * (#6221/#6242), which already lists every actionable node on the current
 * screen, so the added/removed node lists repeat it. Call after the emptiness /
 * replacement checks read them; `changed` stays because the skeleton cannot say
 * what moved from what.
 */
export function dropDiffNodeLists(
  diff: ReturnType<typeof diffObserveResult>,
): Partial<ReturnType<typeof diffObserveResult>> {
  const wireDiff: Partial<typeof diff> = { ...diff };
  delete wireDiff.added;
  delete wireDiff.removed;
  return wireDiff;
}

export function isEmptyObserveDiff(diff: ReturnType<typeof diffObserveResult>): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    diff.displayChanged === undefined &&
    diff.fields === undefined
  );
}

/** Fewest replaced actionable rows that can read as a screen replacement. */
const MIN_REPLACED_ACTIONABLE_NODES = 3;

/**
 * Whether a same-screen-identity diff actually replaces the screen's actionable
 * content (#11638): sub-screens of one activity (Settings' `SubSettings`) share
 * an identity, so navigating between them would otherwise be emitted as a diff
 * of unrelated rows. At least half of the current actionable skeleton having
 * been both added and removed means the client needs the new screen, not a delta.
 */
export function replacedMostActionableNodes(diff: ReturnType<typeof diffObserveResult>): boolean {
  const replaced = Math.min(diff.added.length, diff.removed.length);
  return replaced >= MIN_REPLACED_ACTIONABLE_NODES && replaced * 2 >= (diff.skeleton?.length ?? 0);
}

export function observationScreenIdentity(
  observation: ObserveResult,
): ObservationDiffScreenIdentity {
  const identity: ObservationDiffScreenIdentity = {};
  if (observation.activeWindow) {
    identity.activeWindow = observation.activeWindow;
  }
  if (observation.viewHierarchy?.packageName) {
    identity.hierarchyPackageName = observation.viewHierarchy.packageName;
  }
  if (observation.screenIdentity) {
    identity.screenIdentity = observation.screenIdentity;
  }
  return identity;
}

export function shouldDiffObservation(
  baseline: ObserveResult,
  next: ObserveResult,
  actionClass: ObservationActionClass,
): boolean {
  if (actionClass === "inPlace" || actionClass === "scroll") {
    return isSameStableMutationSurface(baseline, next);
  }
  return isSameObservationScreen(baseline, next);
}

function isSameStableMutationSurface(baseline: ObserveResult, next: ObserveResult): boolean {
  if (!hasSameWindowPackageSurface(baseline, next)) {
    return false;
  }

  return hasCompatibleStableMutationIdentity(baseline, next);
}

function hasCompatibleStableMutationIdentity(
  baseline: ObserveResult,
  next: ObserveResult,
): boolean {
  const baselineIdentity = baseline.screenIdentity;
  const nextIdentity = next.screenIdentity;
  if (!baselineIdentity || !nextIdentity) {
    return true;
  }

  return (
    baselineIdentity.platform === nextIdentity.platform &&
    baselineIdentity.source === nextIdentity.source &&
    baselineIdentity.key === nextIdentity.key
  );
}

/** The window/package facts that identify which app surface an observation shows. */
function windowPackageSurface(result: ObserveResult): readonly string[] {
  return [
    result.activeWindow?.appId ?? "",
    result.activeWindow?.activityName ?? "",
    result.viewHierarchy?.packageName ?? "",
  ];
}

function hasSameWindowPackageSurface(baseline: ObserveResult, next: ObserveResult): boolean {
  const nextSurface = windowPackageSurface(next);
  return windowPackageSurface(baseline).every((value, index) => value === nextSurface[index]);
}
