import { type DisplayInventoryClassification } from "../utils/deviceMatcher";
import type { ConditionEvaluation } from "../features/observe/interfaces/WaitForCondition";
import { waitCaptureUnavailableReason } from "../features/observe/ConditionPredicates";
import { BootedDevice, Element, ObserveResult, ViewHierarchyResult } from "../models";
import { scopeHierarchyToLayer } from "../features/observe/hierarchyLayer";
import type { HierarchyLayer } from "../models/HierarchyLayer";
import { type MatchMode, type ContainerFailure } from "../features/utility/ElementResolver";
import { type ScreenSizeForOffscreenCheckOptions } from "../features/utility/ElementGeometry";
import type { ConditionResolver } from "../features/observe/ConditionPredicates";
import type { ObserveWaitForOptions, WaitForWithSettled } from "./observeWaitForSchemas";
import { findWaitForElement, hasElementPredicate } from "./observeWaitElement";

export interface ObserveConditionEvaluation extends ConditionEvaluation {
  containerFailure?: ContainerFailure;
}

export function containerFailureMetadata(failed: boolean, failure: ContainerFailure | undefined) {
  return failed && failure ? { containerFailure: failure } : {};
}

/** Record resolver diagnostics without changing predicate matching or other tools. */
export function trackContainerFailure(
  finder: ConditionResolver,
  container: ObserveWaitForOptions["container"],
) {
  // Resolution may propagate unique; diagnostics keep each client-sent level.
  const levels: NonNullable<ObserveWaitForOptions["container"]>[] = [];
  for (let level = container; level; level = level.container) {
    levels.unshift(level);
  }
  let failure: ContainerFailure | undefined;
  return {
    finder: {
      resolve: (...args: Parameters<ConditionResolver["resolve"]>) => {
        const result = finder.resolve(...args);
        const resolved = result.containerFailure;
        failure ??= resolved && {
          ...resolved,
          selector: levels[resolved.level - 1] ?? resolved.selector,
        };
        return result;
      },
    } satisfies ConditionResolver,
    failure: () => failure,
    reset: () => {
      failure = undefined;
    },
  };
}

const matchesActiveWindow = (
  observation: ObserveResult,
  waitFor: ObserveWaitForOptions,
  platform?: BootedDevice["platform"],
): boolean => {
  if (!waitFor.activeWindow) {
    return true;
  }

  const activeWindow = observation.activeWindow;
  if (!activeWindow) {
    return false;
  }

  if (
    waitFor.activeWindow.appId !== undefined &&
    activeWindow.appId !== waitFor.activeWindow.appId
  ) {
    return false;
  }

  if (
    platform === "ios" &&
    waitFor.activeWindow.activityName !== undefined &&
    waitFor.activeWindow.appId === undefined
  ) {
    return false;
  }

  if (
    platform !== "ios" &&
    waitFor.activeWindow.activityName !== undefined &&
    activeWindow.activityName !== waitFor.activeWindow.activityName
  ) {
    return false;
  }

  return true;
};

// Absence / negation predicate (issue #3490 §4). Reuses the same element
// matcher: the `absent` fields describe an element that must NOT be present, so
// the predicate is satisfied exactly when no element matches them. Returns true
// (vacuously satisfied) when no `absent` predicate is configured.
const matchesAbsent = (
  finder: ConditionResolver,
  waitFor: ObserveWaitForOptions,
  viewHierarchy: ViewHierarchyResult,
  platform: BootedDevice["platform"] | undefined,
  sizeOptions: ScreenSizeForOffscreenCheckOptions,
  evaluation: ConditionEvaluation,
): boolean => {
  if (!waitFor.absent) {
    return true;
  }
  const absentAsWaitFor = {
    ...waitFor.absent,
    container: waitFor.container,
    selectionStrategy: waitFor.absent.selectionStrategy ?? waitFor.selectionStrategy,
  } as ObserveWaitForOptions;
  return (
    findWaitForElement(finder, absentAsWaitFor, viewHierarchy, platform, new Map(), {
      ...sizeOptions,
      negative: true,
      evaluation,
    }) === null && !evaluation.diagnostic
  );
};

const matchesDisplayStamp = (
  observation: ObserveResult,
  waitFor: ObserveWaitForOptions,
  displayInventory: DisplayInventoryClassification,
): boolean => {
  const display = observation.display;
  const isSingleInventoryStub =
    displayInventory === "single" && display?.key === "0" && display.role === "unknown";
  return (
    (waitFor.posture === undefined || display?.posture === waitFor.posture) &&
    (waitFor.activeDisplay === undefined ||
      (!isSingleInventoryStub &&
        (display?.key === waitFor.activeDisplay || display?.role === waitFor.activeDisplay)))
  );
};

/**
 * The observation an element predicate sees for `layer` (issue #9305). Only the
 * hierarchy is scoped; the polled observation itself, and the cache behind it,
 * keep every window.
 */
export function layerScopedObservation(
  observation: ObserveResult,
  layer: HierarchyLayer | undefined,
): ObserveResult {
  if (layer === undefined || !observation.viewHierarchy) {
    return observation;
  }
  return {
    ...observation,
    viewHierarchy: scopeHierarchyToLayer(observation.viewHierarchy, layer),
  };
}

export const evaluateWaitForObservation = (
  finder: ConditionResolver,
  waitFor: WaitForWithSettled,
  observation: ObserveResult,
  platform: BootedDevice["platform"] | undefined,
  displayInventory: DisplayInventoryClassification,
  { modes, iosMultiPanel }: { modes: Map<string, MatchMode>; iosMultiPanel: boolean },
): ObserveConditionEvaluation & { awaitedElement?: Element } => {
  observation = layerScopedObservation(observation, waitFor.layer);
  const sizeOptions = {
    platform,
    iosMultiPanel,
    observationScreenSize: observation.screenSize,
    display: observation.viewHierarchy,
  };
  const evaluation: ObserveConditionEvaluation = { matched: false };
  const tracked = trackContainerFailure(finder, waitFor.container);
  finder = tracked.finder;
  const needsHierarchy =
    hasElementPredicate(waitFor) || waitFor.absent !== undefined || waitFor.settled !== undefined;
  const diagnostic = needsHierarchy ? waitCaptureUnavailableReason(observation) : undefined;
  if (diagnostic) {
    return { matched: false, diagnostic };
  }
  const activeWindowMatched = matchesActiveWindow(observation, waitFor, platform);
  const displayMatched = matchesDisplayStamp(observation, waitFor, displayInventory);
  const needsElementMatch = hasElementPredicate(waitFor);
  const awaitedElement =
    needsElementMatch && observation.viewHierarchy
      ? findWaitForElement(finder, waitFor, observation.viewHierarchy, platform, modes, {
          ...sizeOptions,
          evaluation,
        })
      : null;
  // The shared admission guard above ensures absence is evaluated only on a
  // usable capture; an unavailable tree cannot prove that an element is gone.
  const absentSatisfied =
    waitFor.absent === undefined
      ? true
      : observation.viewHierarchy
        ? matchesAbsent(
            finder,
            waitFor,
            observation.viewHierarchy,
            platform,
            sizeOptions,
            evaluation,
          )
        : false;

  const matched = [
    activeWindowMatched,
    displayMatched,
    absentSatisfied,
    !needsElementMatch || awaitedElement !== null,
  ].every(Boolean);
  return {
    ...evaluation,
    ...containerFailureMetadata(!matched, tracked.failure()),
    matched,
    awaitedElement: awaitedElement ?? undefined,
  };
};
