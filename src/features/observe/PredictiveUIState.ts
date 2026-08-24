import { DefaultElementParser } from "../utility/ElementParser";
import {
  Element,
  InteractablePrediction,
  ObserveResult,
  PredictedAction,
  PredictionTarget,
  Predictions,
} from "../../models";
import { NavigationEdge, NavigationGraphManager } from "../navigation/NavigationGraphManager";
import { PredictionHistoryRepository } from "../../db/predictionHistoryRepository";
import { normalizeToolArgs, normalizeIdentifier } from "../../utils/predictionUtils";
import type { PredictiveUIState as PredictiveUIStateInterface } from "./interfaces/PredictiveUIState";

interface InteractableElement {
  element: Element;
  text?: string;
  contentDesc?: string;
  resourceId?: string;
  clickable: boolean;
  scrollable: boolean;
}

interface IndexedEdge {
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
export class EdgeMatchIndex {
  // tapOn: keyed by normalized args.text / element id.
  private readonly tapByText = new Map<string, IndexedEdge>();
  private readonly tapById = new Map<string, IndexedEdge>();
  // swipeOn: keyed by normalized container text / id / content-desc.
  private readonly swipeByText = new Map<string, IndexedEdge>();
  private readonly swipeById = new Map<string, IndexedEdge>();
  private readonly swipeByDesc = new Map<string, IndexedEdge>();

  constructor(edges: NavigationEdge[]) {
    edges.forEach((edge, index) => {
      const toolName = edge.interaction?.toolName;
      if (toolName === "tapOn") {
        this.indexTapEdge(edge, index);
      } else if (toolName === "swipeOn") {
        this.indexSwipeEdge(edge, index);
      }
    });
  }

  private indexTapEdge(edge: NavigationEdge, index: number): void {
    const args = edge.interaction?.args;
    this.addKey(this.tapByText, normalizeIdentifier(args?.text), edge, index);
    this.addKey(this.tapById, normalizeIdentifier(args?.elementId ?? args?.id), edge, index);
  }

  private indexSwipeEdge(edge: NavigationEdge, index: number): void {
    const args = edge.interaction?.args;
    const container = args?.container || edge.interaction?.uiState?.scrollPosition?.container;
    if (!container) {
      return;
    }
    this.addKey(this.swipeByText, normalizeIdentifier(container.text), edge, index);
    this.addKey(
      this.swipeById,
      normalizeIdentifier(container.elementId || container.resourceId),
      edge,
      index,
    );
    this.addKey(this.swipeByDesc, normalizeIdentifier(container.contentDesc), edge, index);
  }

  // First edge wins for a given key (preserves edge-order tie-breaking); empty
  // keys are skipped, matching the old `if (!normalized) return false` guards.
  private addKey(
    map: Map<string, IndexedEdge>,
    key: string | undefined,
    edge: NavigationEdge,
    index: number,
  ): void {
    if (!key || map.has(key)) {
      return;
    }
    map.set(key, { edge, index });
  }

  findMatch(interactable: InteractableElement): NavigationEdge | undefined {
    const text = normalizeIdentifier(interactable.text);
    const contentDesc = normalizeIdentifier(interactable.contentDesc);
    const resourceId = normalizeIdentifier(interactable.resourceId);

    let best: IndexedEdge | undefined;
    const consider = (candidate?: IndexedEdge): void => {
      if (candidate && (!best || candidate.index < best.index)) {
        best = candidate;
      }
    };

    if (interactable.clickable) {
      // tapOn: args.text matches the interactable's text or content-desc; an
      // element id matches its resource id.
      if (text) {
        consider(this.tapByText.get(text));
      }
      if (contentDesc) {
        consider(this.tapByText.get(contentDesc));
      }
      if (resourceId) {
        consider(this.tapById.get(resourceId));
      }
    }

    if (interactable.scrollable) {
      // swipeOn: container text matches text/content-desc; container id matches
      // resource id; container content-desc matches content-desc.
      if (text) {
        consider(this.swipeByText.get(text));
      }
      if (contentDesc) {
        consider(this.swipeByText.get(contentDesc));
        consider(this.swipeByDesc.get(contentDesc));
      }
      if (resourceId) {
        consider(this.swipeById.get(resourceId));
      }
    }

    return best?.edge;
  }
}

export class PredictiveUIState implements PredictiveUIStateInterface {
  private elementParser = new DefaultElementParser();
  private historyRepository = new PredictionHistoryRepository();
  private readonly DEFAULT_CONFIDENCE = 0.5;

  async generate(result: ObserveResult): Promise<Predictions | undefined> {
    if (!result.viewHierarchy) {
      return undefined;
    }

    const navGraph = NavigationGraphManager.getInstance();
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

      const predictionTarget = this.buildTarget(match, interactable);
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

  private buildTarget(
    edge: NavigationEdge,
    interactable: InteractableElement,
  ): PredictionTarget | null {
    const args = edge.interaction?.args;
    const uiState = edge.interaction?.uiState;
    const toolName = edge.interaction?.toolName;

    if (toolName === "tapOn") {
      const text = args?.text ?? interactable.text;
      const elementId = args?.elementId ?? args?.id ?? interactable.resourceId;
      const contentDesc = interactable.contentDesc;

      if (!text && !elementId && !contentDesc) {
        return null;
      }

      return {
        text,
        elementId,
        contentDesc,
      };
    }

    if (toolName === "swipeOn") {
      const container = args?.container || uiState?.scrollPosition?.container;
      const lookFor = args?.lookFor || uiState?.scrollPosition?.targetElement;
      const target: PredictionTarget = {};

      if (container) {
        target.container = {
          text: container.text,
          elementId: container.elementId || container.resourceId,
          contentDesc: container.contentDesc,
        };
      }

      if (lookFor) {
        target.lookFor = {
          text: lookFor.text,
          elementId: lookFor.elementId || lookFor.resourceId,
          contentDesc: lookFor.contentDesc,
        };
      }

      if (!target.container && !target.lookFor) {
        return null;
      }

      return target;
    }

    return null;
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
    navGraph: NavigationGraphManager,
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
