import type { ObserveResult } from "../../models";
import {
  getElementTarget,
  predictOutcomeForElement,
  type rankElementsForDryRun,
} from "./ExploreElementScoring";
import type { ExploreDryRunResult } from "./ExploreTypes";

type RankedElements = ReturnType<typeof rankElementsForDryRun>;
type PredictOutcomeEdges = Parameters<typeof predictOutcomeForElement>[1];

/** The ranked elements a dry run would act on, in order, with their predicted outcomes. */
export function planDryRunInteractions(
  ranked: RankedElements,
  edges: PredictOutcomeEdges,
  maxInteractions: number,
): ExploreDryRunResult["plannedInteractions"] {
  return ranked.slice(0, maxInteractions).map((entry, index) => ({
    order: index + 1,
    action: entry.action,
    target: getElementTarget(entry.element),
    reason: entry.reason,
    predictedOutcome: predictOutcomeForElement(entry.element, edges),
    whitelistStatus: entry.whitelistStatus,
  }));
}

/** Which screens the planned interactions are predicted to reach, against the known graph. */
export function dryRunCoverage(
  plannedInteractions: ExploreDryRunResult["plannedInteractions"],
  knownScreens: readonly string[],
): { uniqueScreens: string[]; newScreensExpected: number; existingScreensToRevisit: number } {
  const predictedScreens = plannedInteractions
    .map((interaction) => interaction.predictedOutcome.screen)
    .filter((screen) => screen && screen !== "unknown");
  const uniqueScreens = Array.from(new Set(predictedScreens));
  const knownScreenSet = new Set(knownScreens);
  const existingScreensToRevisit = uniqueScreens.filter((screen) =>
    knownScreenSet.has(screen),
  ).length;
  return {
    uniqueScreens,
    newScreensExpected: uniqueScreens.length - existingScreensToRevisit,
    existingScreensToRevisit,
  };
}

export function dryRunScreenWarnings(currentScreen: string, edgeCount: number): string[] {
  if (currentScreen === "unknown") {
    return ["Current screen is unknown; outcome predictions may be limited."];
  }
  return edgeCount === 0 ? ["No navigation edges recorded for the current screen."] : [];
}

export function dryRunPackageWarnings(
  targetPackageName: string | null,
  currentPackage: string | null | undefined,
): string[] {
  if (targetPackageName && currentPackage && targetPackageName !== currentPackage) {
    return [`Foreground package '${currentPackage}' does not match target '${targetPackageName}'.`];
  }
  return [];
}

/** The dry-run result when the view hierarchy could not be read. */
export function unreadableDryRunResult(
  observation: ObserveResult,
  warnings: string[],
  durationMs: number,
): ExploreDryRunResult {
  return {
    success: true,
    dryRun: true,
    currentScreen: { name: "unknown", interactableElements: 0 },
    plannedInteractions: [],
    estimatedCoverage: {
      screensToVisit: [],
      newScreensExpected: 0,
      existingScreensToRevisit: 0,
    },
    warnings,
    observation,
    durationMs,
  };
}
