import { Element, ObserveResult } from "../../models";
import { PerformanceTracker } from "../../utils/PerformanceTracker";
import { type NavigationGraphService } from "./NavigationGraphManager";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { Timer } from "../../utils/SystemTimer";
import { filterPermissionNavigationCandidates } from "./ExploreBlockerDetection";
import {
  dryRunCoverage,
  dryRunPackageWarnings,
  dryRunScreenWarnings,
  planDryRunInteractions,
  unreadableDryRunResult,
} from "./ExploreDryRunPlan";
import {
  extractAllElements,
  extractNavigationElements,
  extractScrollableContainers,
} from "./ExploreElementExtraction";
import { rankElementsForDryRun } from "./ExploreElementScoring";
import type { ExploreDryRunResult, ExploreOptions, TrackedElement } from "./ExploreTypes";

interface DryRunPlanningContext {
  maxInteractions: number;
  navigationManager: NavigationGraphService;
  elementParser: ElementParser;
  timer: Timer;
  targetPackageName: string | null;
  exploredElements: Map<string, TrackedElement>;
}
export function getObservationPackageName(observation: ObserveResult): string | null {
  const packageName =
    observation.viewHierarchy?.packageName ?? observation.activeWindow?.appId ?? null;

  if (!packageName) {
    return null;
  }

  const trimmed = packageName.trim();
  return trimmed.length > 0 ? trimmed : null;
}
export function getSafeExplorationCandidates(
  observation: ObserveResult,
  elementParser: ElementParser,
): Element[] {
  const viewHierarchy = observation.viewHierarchy;
  if (!viewHierarchy || viewHierarchy.hierarchy.error) {
    return [];
  }

  const navigationElements = extractNavigationElements(viewHierarchy, elementParser);
  const scrollableContainers = extractScrollableContainers(viewHierarchy, elementParser);
  // Retain the permission fast-path's conservative deny-label policy at selection.
  return filterPermissionNavigationCandidates(
    [...navigationElements, ...scrollableContainers],
    extractAllElements(viewHierarchy, elementParser),
  );
}
/** Plan from a single captured hierarchy without dispatching any interaction. */
export async function planExplorationDryRun(
  observation: ObserveResult,
  options: ExploreOptions,
  context: DryRunPlanningContext,
  perf: PerformanceTracker,
  startTime: number,
): Promise<ExploreDryRunResult> {
  const strategy = options.strategy ?? "weighted";
  const mode = options.mode ?? "hybrid";
  const maxInteractions = context.maxInteractions;
  const warnings: string[] = [];
  const viewHierarchy = observation.viewHierarchy;
  if (!viewHierarchy || viewHierarchy.hierarchy.error) {
    warnings.push("Unable to inspect view hierarchy for dry run planning.");
    return unreadableDryRunResult(observation, warnings, context.timer.now() - startTime);
  }

  warnings.push(
    ...dryRunPackageWarnings(context.targetPackageName, getObservationPackageName(observation)),
  );

  const currentScreen = context.navigationManager.getCurrentScreen() ?? "unknown";
  const edges =
    currentScreen !== "unknown" ? await context.navigationManager.getEdgesFrom(currentScreen) : [];

  const navigationElements = extractNavigationElements(viewHierarchy, context.elementParser);
  const scrollableContainers = extractScrollableContainers(viewHierarchy, context.elementParser);
  const allCandidates = [...navigationElements, ...scrollableContainers];
  const safeCandidates = filterPermissionNavigationCandidates(
    allCandidates,
    extractAllElements(viewHierarchy, context.elementParser),
  );

  if (safeCandidates.length === 0) {
    warnings.push("No interactable elements were detected on the current screen.");
  }

  const plannedInteractions = planDryRunInteractions(
    rankElementsForDryRun(safeCandidates, strategy, mode, context.exploredElements),
    edges,
    maxInteractions,
  );
  const { uniqueScreens, newScreensExpected, existingScreensToRevisit } = dryRunCoverage(
    plannedInteractions,
    await context.navigationManager.getKnownScreens(),
  );
  warnings.push(...dryRunScreenWarnings(currentScreen, edges.length));

  perf.end();
  return {
    success: true,
    dryRun: true,
    currentScreen: {
      name: currentScreen,
      interactableElements: safeCandidates.length,
    },
    plannedInteractions,
    estimatedCoverage: {
      screensToVisit: uniqueScreens,
      newScreensExpected,
      existingScreensToRevisit,
    },
    warnings,
    observation,
    durationMs: context.timer.now() - startTime,
  };
}
