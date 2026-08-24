import { createHash } from "crypto";
import type { Element } from "../../models";
import type { NavigationEdge, NavigationGraphManager } from "./NavigationGraphManager";
import type { Timer } from "../../utils/SystemTimer";
import type { EdgeValidationResult, GraphTraversalState } from "./ExploreTypes";
import { logger } from "../../utils/logger";
import { scoreScrollPositionMatch, scoreSelectedElementMatch } from "./ExploreElementScoring";

/**
 * Initialize graph traversal state for validate mode
 */
export async function initializeGraphTraversal(
  navigationManager: NavigationGraphManager,
): Promise<GraphTraversalState> {
  const graph = await navigationManager.exportGraph();
  const allEdges: NavigationEdge[] = [];

  // Collect all edges from the graph
  for (const edge of graph.edges) {
    allEdges.push(edge);
  }

  const state: GraphTraversalState = {
    visitedNodes: new Set<string>(),
    traversedEdges: new Set<string>(),
    pendingEdges: new Map<string, NavigationEdge>(),
    pendingEdgesByFrom: new Map<string, NavigationEdge[]>(),
    edgeValidationResults: new Map<string, EdgeValidationResult>(),
    totalNodesInGraph: graph.nodes.length,
    totalEdgesInGraph: allEdges.length,
  };

  // Hash each edge key exactly once here; markEdgeTraversed then removes by key
  // (O(1)) instead of re-hashing every pending edge on every traversal (O(E^2)).
  for (const edge of allEdges) {
    addPendingEdge(state, edge);
  }

  logger.info(
    `[Explore] Initialized graph traversal: ${graph.nodes.length} nodes, ${allEdges.length} edges`,
  );

  return state;
}

/**
 * Add an edge to the pending set, keeping the key map and the `from` index in
 * sync. The edge key is computed once here; deduplicates by key.
 */
export function addPendingEdge(state: GraphTraversalState, edge: NavigationEdge): void {
  const edgeKey = getEdgeKey(edge);
  if (state.pendingEdges.has(edgeKey)) {
    return;
  }
  state.pendingEdges.set(edgeKey, edge);

  const fromBucket = state.pendingEdgesByFrom.get(edge.from);
  if (fromBucket) {
    fromBucket.push(edge);
  } else {
    state.pendingEdgesByFrom.set(edge.from, [edge]);
  }
}

/**
 * Remove a pending edge by key from both the key map (O(1)) and the `from`
 * index (O(deg), by object identity so no re-hashing).
 */
function removePendingEdge(state: GraphTraversalState, edgeKey: string): void {
  const stored = state.pendingEdges.get(edgeKey);
  if (!stored) {
    return;
  }
  state.pendingEdges.delete(edgeKey);

  const fromBucket = state.pendingEdgesByFrom.get(stored.from);
  if (fromBucket) {
    const idx = fromBucket.indexOf(stored);
    if (idx !== -1) {
      fromBucket.splice(idx, 1);
    }
    if (fromBucket.length === 0) {
      state.pendingEdgesByFrom.delete(stored.from);
    }
  }
}

/**
 * Generate edge key for tracking
 * Uses hash of the action/interaction to ensure uniqueness for multiple edges between same screens
 * Format: {from}->{action_hash}->{to}
 */
export function getEdgeKey(edge: NavigationEdge): string {
  const actionHash = hashEdgeAction(edge);
  return `${edge.from}->${actionHash}->${edge.to}`;
}

/**
 * Create a deterministic hash of the edge's action/interaction
 * This ensures the same interaction always produces the same hash
 */
export function hashEdgeAction(edge: NavigationEdge): string {
  // For edges without interactions (back button, unknown), use edge type
  if (!edge.interaction) {
    return createHash("sha256").update(`${edge.edgeType}`).digest("hex").substring(0, 8);
  }

  // Create a stable representation of the interaction, excluding timestamps
  const stableData = {
    toolName: edge.interaction.toolName,
    // Sort args keys for stability, exclude any timestamp-like fields
    args: Object.fromEntries(
      Object.keys(edge.interaction.args)
        .filter((k) => !k.toLowerCase().includes("timestamp"))
        .sort()
        .map((key) => [key, edge.interaction!.args[key]]),
    ),
    // Include edge type for additional uniqueness
    edgeType: edge.edgeType,
  };

  return createHash("sha256").update(JSON.stringify(stableData)).digest("hex").substring(0, 8); // Use first 8 chars for readability
}

/**
 * Mark current node as visited
 */
export function markNodeVisited(state: GraphTraversalState, screenName: string): void {
  state.visitedNodes.add(screenName);
}

/**
 * Mark edge as traversed with validation result
 */
export function markEdgeTraversed(
  state: GraphTraversalState,
  edge: NavigationEdge,
  actualTo: string | null,
  success: boolean,
  timer: Timer,
  error?: string,
  matchConfidence?: number,
): void {
  const edgeKey = getEdgeKey(edge);
  state.traversedEdges.add(edgeKey);

  const validationResult: EdgeValidationResult = {
    edgeKey,
    fromScreen: edge.from,
    expectedTo: edge.to,
    actualTo,
    success,
    timestamp: timer.now(),
    error,
    matchConfidence,
  };

  state.edgeValidationResults.set(edgeKey, validationResult);

  // Remove from pending edges (O(1) map delete + O(deg) index splice)
  removePendingEdge(state, edgeKey);

  logger.info(
    `[Explore] Edge ${edgeKey} validation: ${success ? "SUCCESS" : "FAILED"}` +
      (actualTo && actualTo !== edge.to ? ` (went to ${actualTo})` : ""),
  );
}

/**
 * Select next edge to traverse in validate mode
 * Only selects edges from the current screen to avoid false divergence
 */
export function selectNextEdgeToTraverse(
  state: GraphTraversalState,
  currentScreen: string,
): NavigationEdge | null {
  // Only select untraversed edges from current screen
  // Do not attempt to navigate to other screens, as this causes false divergence.
  // Empty buckets are pruned on removal, so a present bucket always has an edge.
  const untraversedFromCurrent = state.pendingEdgesByFrom.get(currentScreen);
  return untraversedFromCurrent ? untraversedFromCurrent[0] : null;
}

/**
 * Find element on screen that matches a target edge
 */
export function findElementMatchingEdge(
  elements: Element[],
  edge: NavigationEdge,
): { element: Element; confidence: number } | null {
  const uiState = edge.uiState || edge.interaction?.uiState;
  if (!uiState) {
    logger.warn(`[Explore] Edge ${edge.from}->${edge.to} has no UI state, cannot match`);
    return null;
  }

  let bestMatch: { element: Element; confidence: number } | null = null;
  let bestScore = 0;

  for (const element of elements) {
    // Try to match against selected elements in the edge's UI state
    if (uiState.selectedElements && uiState.selectedElements.length > 0) {
      for (const selected of uiState.selectedElements) {
        const score = scoreSelectedElementMatch(element, selected);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = { element, confidence: score };
        }
      }
    }

    // Try to match against scroll position if present
    if (uiState.scrollPosition) {
      const score = scoreScrollPositionMatch(element, uiState.scrollPosition);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = { element, confidence: score };
      }
    }
  }

  // Require minimum confidence threshold
  const MIN_CONFIDENCE = 0.6;
  if (bestMatch && bestMatch.confidence >= MIN_CONFIDENCE) {
    logger.debug(
      `[Explore] Matched element for edge ${edge.from}->${edge.to} with confidence ${bestMatch.confidence.toFixed(2)}`,
    );
    return bestMatch;
  }

  logger.warn(
    `[Explore] No confident match for edge ${edge.from}->${edge.to} ` +
      `(best score: ${bestScore.toFixed(2)}, threshold: ${MIN_CONFIDENCE})`,
  );
  return null;
}

/**
 * Validate that navigation matched expected edge in validate mode
 * Returns true if navigation succeeded, false if it diverged
 */
export async function validateNavigation(
  expectedEdge: NavigationEdge,
  state: GraphTraversalState,
  navigationManager: NavigationGraphManager,
  timer: Timer,
  elementConfidence: number,
  setStopReason: (reason: string) => void,
): Promise<boolean> {
  // Wait a bit for navigation to complete
  await timer.sleep(500);

  const actualScreen = navigationManager.getCurrentScreen() ?? "unknown";
  const success = actualScreen === expectedEdge.to;

  // Mark edge as traversed with result
  markEdgeTraversed(
    state,
    expectedEdge,
    actualScreen,
    success,
    timer,
    success ? undefined : `Expected ${expectedEdge.to}, got ${actualScreen}`,
    elementConfidence,
  );

  if (!success) {
    const errorMsg =
      `Validate mode: Navigation validation failed for edge ${expectedEdge.from}->${expectedEdge.to}. ` +
      `Expected to reach "${expectedEdge.to}", but reached "${actualScreen}". ` +
      `App has diverged from known graph.`;
    logger.error(`[Explore] ${errorMsg}`);
    setStopReason(errorMsg);
  }

  return success;
}
