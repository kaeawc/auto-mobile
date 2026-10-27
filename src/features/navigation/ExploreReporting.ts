import { ExportedGraph } from "../../utils/interfaces/NavigationGraph";
import { type NavigationGraphService } from "./NavigationGraphManager";
import { Timer } from "../../utils/SystemTimer";
import type { ElementSelectionStats, ExploreResult, GraphTraversalState } from "./ExploreTypes";
import { countNewTransitions } from "./ExploreValidateMode";

interface ExploreReportState {
  explorationPath: string[];
  graphTraversalState: GraphTraversalState | null;
  interactionCount: number;
  elementSelections: ElementSelectionStats[];
  stopReason: string;
}
interface ExploreReportContext {
  navigationManager: NavigationGraphService;
  timer: Timer;
  getState(): ExploreReportState;
}
function traversalStopReason(
  stopReason: string,
  graphTraversalState: GraphTraversalState | null,
): string {
  const reason = stopReason || "Exploration completed successfully";
  const state = graphTraversalState;
  if (!state || state.pendingEdges.size === 0) {
    return reason;
  }

  const results = Array.from(state.edgeValidationResults.values());
  const validated = results.filter((result) => result.success).length;
  const skipped = results.filter((result) => result.skipped).length;
  const failed = results.length - validated - skipped;
  const skippedNote = skipped > 0 ? `${skipped} skipped (not replayable); ` : "";
  const pending = Array.from(
    state.pendingEdges,
    ([key, edge]) => `${edge.from}->${edge.to} (${key})`,
  );
  // A budget/safety stop proves these were not reached in this run, not that
  // they are globally unreachable. Preserve its reason alongside the remainder.
  return (
    `${reason}. Validated ${validated} of ${state.totalEdgesInGraph} edges; ` +
    `${failed} failed validation; ${skippedNote}${state.pendingEdges.size} remain pending. ` +
    `Pending edges not reached before stopping (source->destination): ${pending.join(", ")}`
  );
}
/** Assemble coverage and traversal diagnostics after the final graph read. */
export async function generateExplorationReport(
  initialGraph: ExportedGraph,
  startTime: number,
  cancelled: boolean,
  context: ExploreReportContext,
): Promise<ExploreResult> {
  const finalGraph = initialGraph.appId
    ? await context.navigationManager.exportGraphForApp(initialGraph.appId)
    : await context.navigationManager.exportGraph();
  const state = context.getState();
  const screensDiscovered = Math.max(0, finalGraph.nodes.length - initialGraph.nodes.length);
  const edgesAdded = countNewTransitions(initialGraph.edges, finalGraph.edges);

  // Calculate coverage
  const totalScreens = finalGraph.nodes.length;
  const exploredScreens = new Set(state.explorationPath).size;
  const coveragePercentage = totalScreens > 0 ? (exploredScreens / totalScreens) * 100 : 0;

  // Build graph traversal metrics if in validate mode
  let graphTraversal: ExploreResult["graphTraversal"];
  if (state.graphTraversalState) {
    const traversalCoverage =
      state.graphTraversalState.totalEdgesInGraph > 0
        ? (state.graphTraversalState.traversedEdges.size /
            state.graphTraversalState.totalEdgesInGraph) *
          100
        : 0;

    graphTraversal = {
      nodesVisited: state.graphTraversalState.visitedNodes.size,
      totalNodes: state.graphTraversalState.totalNodesInGraph,
      edgesTraversed: state.graphTraversalState.traversedEdges.size,
      totalEdges: state.graphTraversalState.totalEdgesInGraph,
      edgeValidationResults: Array.from(state.graphTraversalState.edgeValidationResults.values()),
      coveragePercentage: Math.round(traversalCoverage * 100) / 100,
    };
  }

  return {
    success: true,
    cancelled,
    interactionsPerformed: state.interactionCount,
    screensDiscovered,
    edgesAdded,
    navigationGraph: finalGraph,
    explorationPath: state.explorationPath,
    coverage: {
      totalScreens,
      exploredScreens,
      percentage: Math.round(coveragePercentage * 100) / 100,
    },
    elementSelections: state.elementSelections,
    durationMs: context.timer.now() - startTime,
    stopReason: traversalStopReason(state.stopReason, state.graphTraversalState),
    graphTraversal,
  };
}

/** A reset runs once per completed interaction interval, including across stalled observations. */
export function isExplorationResetDue(
  interactionCount: number,
  lastResetAt: number,
  resetInterval: number,
): boolean {
  return (
    interactionCount > 0 &&
    interactionCount !== lastResetAt &&
    interactionCount % resetInterval === 0
  );
}
