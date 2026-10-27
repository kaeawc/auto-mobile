import { Element } from "../../models";
import { logger } from "../../utils/logger";
import { type NavigationEdge, type NavigationGraphService } from "./NavigationGraphManager";
import { Timer } from "../../utils/SystemTimer";
import type { GraphTraversalState } from "./ExploreTypes";
import {
  markEdgeSkipped,
  markEdgeTraversed,
  markNodeVisited,
  resolveEdgeTarget,
  selectNextEdgeToTraverse,
} from "./ExploreValidateMode";

export interface ExploreValidationSelection {
  stopReason: string;
  currentTargetEdge: NavigationEdge | null;
  currentElementConfidence: number;
  recordedBackEdge: NavigationEdge | null;
}
interface ValidationSelectionContext {
  graphTraversalState: GraphTraversalState | null;
  navigationManager: NavigationGraphService;
  timer: Timer;
}
function targetValidateEdge(
  selection: ExploreValidationSelection,
  targetEdge: NavigationEdge,
  match: { element: Element; confidence: number },
): Element {
  logger.info(
    `[Explore] Validate mode: targeting edge ${targetEdge.from}->${targetEdge.to} ` +
      `(confidence: ${(match.confidence * 100).toFixed(0)}%)`,
  );
  selection.currentTargetEdge = targetEdge;
  selection.currentElementConfidence = match.confidence;
  return match.element;
}
export function selectValidateElement(
  candidates: Element[],
  context: ValidationSelectionContext,
  selection: ExploreValidationSelection,
): Element | null {
  const state = context.graphTraversalState;
  if (!state) {
    return null;
  }
  const currentScreen = context.navigationManager.getCurrentScreen() ?? "unknown";
  if (currentScreen !== "unknown") {
    markNodeVisited(state, currentScreen);
  }

  // Each skipped edge leaves the pending set, so this terminates.
  for (;;) {
    const targetEdge = selectNextEdgeToTraverse(state, currentScreen);
    if (!targetEdge) {
      if (state.pendingEdges.size === 0) {
        selection.stopReason = "All edges in navigation graph have been traversed";
        logger.info(`[Explore] ${selection.stopReason}`);
      }
      // Pending sources elsewhere: let the loop use its bounded back recovery.
      return null;
    }

    const resolution = resolveEdgeTarget(candidates, targetEdge);
    if (resolution.status === "not-validatable") {
      // A property of the recorded edge, not of the app: skip it and try the next one.
      markEdgeSkipped(state, targetEdge, resolution.reason, context.timer);
      continue;
    }
    if (resolution.status === "back") {
      // Nothing to tap: the loop replays this edge with the Back button.
      selection.currentTargetEdge = targetEdge;
      selection.currentElementConfidence = 1;
      selection.recordedBackEdge = targetEdge;
      return null;
    }
    if (resolution.status === "not-found") {
      selection.stopReason =
        `Validate mode: Cannot find element matching edge ${targetEdge.from}->${targetEdge.to}. ` +
        `App may have diverged from known graph.`;
      logger.error(`[Explore] ${selection.stopReason}`);
      markEdgeTraversed(
        state,
        targetEdge,
        { actualTo: null, success: false, error: "Element not found on screen" },
        context.timer,
      );
      return null;
    }
    return targetValidateEdge(selection, targetEdge, resolution);
  }
}
