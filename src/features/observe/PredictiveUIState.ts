import { DefaultElementParser } from "../utility/ElementParser";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import {
  Element,
  InteractablePrediction,
  ObserveResult,
  PredictedAction,
  PredictionTarget,
  Predictions,
} from "../../models";
import type { NavigationEdge, NavigationGraphService } from "../navigation/NavigationGraphManager";
import {
  resolveNavigationGraphForDevice,
  type NavigationDeviceRef,
  type NavigationGraphResolver,
} from "../navigation/deviceNavigationGraph";
import { PredictionHistoryRepository } from "../../db/predictionHistoryRepository";
import { normalizeToolArgs } from "../../utils/predictionUtils";
import type { PredictiveUIState as PredictiveUIStateInterface } from "./interfaces/PredictiveUIState";
import { EdgeMatchIndex } from "./EdgeMatchIndex";

export interface InteractableElement {
  element: Element;
  text?: string;
  contentDesc?: string;
  resourceId?: string;
  clickable: boolean;
  scrollable: boolean;
}

export interface IndexedEdge {
  edge: NavigationEdge;
  index: number;
}

/**
 * Pre-normalized lookup index over a screen's actionable edges (issue #3428).
 *
 * The old `findMatchingEdge` re-ran `.trim().toLowerCase()` on every edge's args
 * for every interactable (O(interactables x edges) normalizations) and linearly
 * scanned all edges per interactable. This normalizes each edge exactly once at
 * construction and resolves each interactable via a constant number of Map
 * lookups: O(I x E) -> O(I + E).
 *
 * `findMatch` returns the edge with the lowest original index among all matching
 * paths, which is identical to the previous "first edge in edge order that
 * matches by any path" behavior.
 */
/** The navigation graph reads prediction building uses. */
type PredictionNavGraph = Pick<
  NavigationGraphService,
  "getCurrentScreen" | "getCurrentAppId" | "getEdgesFrom"
>;

/** Collaborators a PredictiveUIState reads; defaults are the real parser and DB-backed history. */
export interface PredictiveUIStateDependencies {
  elementParser?: Pick<ElementParser, "flattenViewHierarchy">;
  historyRepository?: Pick<PredictionHistoryRepository, "getTransitionStatsForScreen">;
}

export class PredictiveUIState implements PredictiveUIStateInterface {
  private readonly elementParser: Pick<ElementParser, "flattenViewHierarchy">;
  private readonly historyRepository: Pick<
    PredictionHistoryRepository,
    "getTransitionStatsForScreen"
  >;
  private readonly DEFAULT_CONFIDENCE = 0.5;

  constructor(
    private readonly resolveNavigationGraph: NavigationGraphResolver = resolveNavigationGraphForDevice,
    dependencies: PredictiveUIStateDependencies = {},
  ) {
    this.elementParser = dependencies.elementParser ?? new DefaultElementParser();
    this.historyRepository = dependencies.historyRepository ?? new PredictionHistoryRepository();
  }

  async generate(
    result: ObserveResult,
    device?: NavigationDeviceRef,
  ): Promise<Predictions | undefined> {
    if (!result.viewHierarchy) {
      return undefined;
    }

    // The manager the device's navigation events are recorded on: its bound session's, else
    // the global one (#10197).
    const navGraph = this.resolveNavigationGraph(device);
    const currentScreen = navGraph.getCurrentScreen();
    if (!currentScreen) {
      return undefined;
    }

    const appId = navGraph.getCurrentAppId();
    if (appId && result.activeWindow?.appId && appId !== result.activeWindow.appId) {
      return undefined;
    }

    const edges = await navGraph.getEdgesFrom(currentScreen);
    const actionableEdges = edges.filter(
      (edge) => edge.interaction?.toolName === "tapOn" || edge.interaction?.toolName === "swipeOn",
    );
    if (actionableEdges.length === 0) {
      return undefined;
    }

    const interactables = this.extractInteractables(result.viewHierarchy);
    if (interactables.length === 0) {
      return undefined;
    }

    return this.buildPredictions(interactables, actionableEdges, navGraph, {
      currentScreen,
      appId,
    });
  }

  private async buildPredictions(
    interactables: InteractableElement[],
    actionableEdges: NavigationEdge[],
    navGraph: PredictionNavGraph,
    { currentScreen, appId }: { currentScreen: string; appId: string | null },
  ): Promise<Predictions | undefined> {
    const likelyActions: PredictedAction[] = [];
    const interactableElements: InteractablePrediction[] = [];
    const matchedEdges = new Set<string>();
    const predictedElementsByScreen = new Map<string, string[]>();
    const transitionStats = appId
      ? await this.historyRepository.getTransitionStatsForScreen(appId, currentScreen)
      : [];
    const transitionStatsByKey = new Map<string, (typeof transitionStats)[number]>();
    for (const stat of transitionStats) {
      const key = this.buildTransitionKey(
        stat.from_screen,
        stat.to_screen,
        stat.tool_name,
        stat.tool_args,
      );
      transitionStatsByKey.set(key, stat);
    }

    const edgeIndex = new EdgeMatchIndex(actionableEdges);

    for (const interactable of interactables) {
      const match = edgeIndex.findMatch(interactable);
      if (!match || !match.interaction) {
        continue;
      }

      const predictionTarget = buildPredictionTarget(match, interactable);
      if (!predictionTarget) {
        continue;
      }

      const edgeKey = this.buildEdgeKey(match);
      if (!matchedEdges.has(edgeKey)) {
        const predictedElements = await this.getPredictedElements(
          navGraph,
          match.to,
          predictedElementsByScreen,
        );
        const confidence = this.getAdjustedConfidence(
          transitionStatsByKey.get(
            this.buildTransitionKey(
              currentScreen,
              match.to,
              match.interaction.toolName,
              normalizeToolArgs(match.interaction.args),
            ),
          ),
        );
        likelyActions.push({
          action: match.interaction.toolName,
          target: predictionTarget,
          predictedScreen: match.to,
          predictedElements: predictedElements.length > 0 ? predictedElements : undefined,
          confidence,
        });
        matchedEdges.add(edgeKey);
      }

      interactableElements.push({
        elementId: interactable.resourceId,
        elementText: interactable.text,
        elementContentDesc: interactable.contentDesc,
        predictedOutcome: {
          screenName: match.to,
          basedOn: "navigation_graph",
        },
      });
    }

    if (likelyActions.length === 0 && interactableElements.length === 0) {
      return undefined;
    }

    return {
      likelyActions,
      interactableElements,
    };
  }

  private extractInteractables(
    viewHierarchy: ObserveResult["viewHierarchy"],
  ): InteractableElement[] {
    if (!viewHierarchy) {
      return [];
    }

    const flattened = this.elementParser.flattenViewHierarchy(viewHierarchy);
    const interactables: InteractableElement[] = [];

    for (const { element } of flattened) {
      const clickable = element.clickable === true || element.clickable === "true";
      const scrollable = element.scrollable === true || element.scrollable === "true";
      if (!clickable && !scrollable) {
        continue;
      }

      interactables.push({
        element,
        text: element.text,
        contentDesc: element["content-desc"],
        resourceId: element["resource-id"],
        clickable,
        scrollable,
      });
    }

    return interactables;
  }

  private buildEdgeKey(edge: NavigationEdge): string {
    const args = edge.interaction?.args ?? {};
    return `${edge.from}:${edge.to}:${edge.interaction?.toolName}:${JSON.stringify(args)}`;
  }

  private buildTransitionKey(
    fromScreen: string,
    toScreen: string,
    toolName: string,
    toolArgs: string,
  ): string {
    return `${fromScreen}:${toScreen}:${toolName}:${toolArgs}`;
  }

  private getAdjustedConfidence(stats?: { attempts: number; successes: number }): number {
    if (!stats) {
      return this.DEFAULT_CONFIDENCE;
    }

    const attempts = stats.attempts;
    const accuracy = attempts > 0 ? stats.successes / attempts : this.DEFAULT_CONFIDENCE;
    return this.adjustConfidence(this.DEFAULT_CONFIDENCE, accuracy, attempts);
  }

  private adjustConfidence(
    baseConfidence: number,
    historicalAccuracy: number,
    sampleSize: number,
  ): number {
    const historyWeight = Math.min(sampleSize / 100, 0.8);
    const baseWeight = 1 - historyWeight;
    const adjusted = baseConfidence * baseWeight + historicalAccuracy * historyWeight;
    return Math.max(0, Math.min(1, adjusted));
  }

  private async getPredictedElements(
    navGraph: PredictionNavGraph,
    screenName: string,
    cache: Map<string, string[]>,
  ): Promise<string[]> {
    if (cache.has(screenName)) {
      return cache.get(screenName) ?? [];
    }

    const edges = await navGraph.getEdgesFrom(screenName);
    const identifiers = new Set<string>();

    for (const edge of edges) {
      const selectedElements = edge.interaction?.uiState?.selectedElements;
      if (!selectedElements) {
        continue;
      }

      for (const selected of selectedElements) {
        const identifier = selected.text || selected.resourceId || selected.contentDesc;
        if (identifier) {
          identifiers.add(identifier);
        }
      }
    }

    const predictedElements = Array.from(identifiers);
    cache.set(screenName, predictedElements);
    return predictedElements;
  }
}

/**
 * The action target a navigation edge predicts for an interactable element, or null when the
 * edge carries nothing to target. Pure: no navigation graph or history access.
 */
export function buildPredictionTarget(
  edge: NavigationEdge,
  interactable: InteractableElement,
): PredictionTarget | null {
  const args = edge.interaction?.args;
  const uiState = edge.interaction?.uiState;
  const toolName = edge.interaction?.toolName;

  if (toolName === "tapOn") {
    return buildTapTarget(args, interactable);
  }

  if (toolName === "swipeOn") {
    return buildSwipeTarget(args, uiState);
  }

  return null;
}

function buildTapTarget(
  args: NonNullable<NavigationEdge["interaction"]>["args"] | undefined,
  interactable: InteractableElement,
): PredictionTarget | null {
  const text = args?.text ?? interactable.text;
  const elementId = args?.elementId ?? args?.id ?? interactable.resourceId;
  const contentDesc = interactable.contentDesc;

  if (!text && !elementId && !contentDesc) {
    return null;
  }

  return { text, elementId, contentDesc };
}

function buildSwipeTarget(
  args: NonNullable<NavigationEdge["interaction"]>["args"] | undefined,
  uiState: NonNullable<NavigationEdge["interaction"]>["uiState"],
): PredictionTarget | null {
  const { container, lookFor } = getSwipeTargets(args, uiState);
  const target: PredictionTarget = {};

  if (container) {
    target.container = buildSwipeSelector(container);
  }

  if (lookFor) {
    target.lookFor = buildSwipeSelector(lookFor);
  }

  if (!target.container && !target.lookFor) {
    return null;
  }

  return target;
}

function getSwipeTargets(
  args: NonNullable<NavigationEdge["interaction"]>["args"] | undefined,
  uiState: NonNullable<NavigationEdge["interaction"]>["uiState"],
): {
  container: (NonNullable<PredictionTarget["container"]> & { resourceId?: string }) | undefined;
  lookFor: (NonNullable<PredictionTarget["lookFor"]> & { resourceId?: string }) | undefined;
} {
  const container = args?.container || uiState?.scrollPosition?.container;
  const lookFor = args?.lookFor || uiState?.scrollPosition?.targetElement;
  return { container, lookFor };
}

function buildSwipeSelector(
  selector: NonNullable<PredictionTarget["container"]> & { resourceId?: string },
): NonNullable<PredictionTarget["container"]> {
  return {
    text: selector.text,
    elementId: selector.elementId || selector.resourceId,
    contentDesc: selector.contentDesc,
  };
}
