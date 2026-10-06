import { createHash } from "crypto";
import type { Element } from "../../models";
import type { NavigationEdge, NavigationGraphService } from "./NavigationGraphManager";
import type { Timer } from "../../utils/SystemTimer";
import type { EdgeValidationResult, GraphTraversalState } from "./ExploreTypes";
import { logger } from "../../utils/logger";
import { scoreSelectedElementMatch } from "./ExploreElementScoring";

/**
 * Initialize graph traversal state for validate mode
 */
export async function initializeGraphTraversal(
  navigationManager: Pick<NavigationGraphService, "exportGraph">,
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
 * Record that an edge cannot be validated by tapping (no replayable element
 * interaction). It leaves the pending set but is neither a validation success
 * nor a failure, and it does not count as traversed.
 */
export function markEdgeSkipped(
  state: GraphTraversalState,
  edge: NavigationEdge,
  reason: string,
  timer: Timer,
): void {
  const edgeKey = getEdgeKey(edge);
  state.edgeValidationResults.set(edgeKey, {
    edgeKey,
    fromScreen: edge.from,
    expectedTo: edge.to,
    actualTo: null,
    success: false,
    skipped: true,
    timestamp: timer.now(),
    error: `Not validatable: ${reason}`,
  });
  removePendingEdge(state, edgeKey);
  logger.info(`[Explore] Edge ${edgeKey} skipped: ${reason}`);
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

/** Element identity the recorded interaction addressed, in the shape the scorer takes. */
interface TargetDescriptor {
  text?: string;
  resourceId?: string;
  contentDesc?: string;
}

/**
 * How validate mode resolves the on-screen target for a recorded edge.
 * `not-validatable` is a property of the recorded edge (no replayable element
 * interaction), not a sign that the app diverged from the graph. `back` is a
 * recorded Back press: replayed with the Back button, so it has no element.
 */
export type EdgeTargetResolution =
  | { status: "matched"; element: Element; confidence: number }
  | { status: "back" }
  | { status: "not-validatable"; reason: string }
  | { status: "not-found"; bestScore: number };

type TargetDescriptors = { descriptors: TargetDescriptor[] } | { reason: string };

const MIN_CONFIDENCE = 0.6;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** tapOn's `text` selector matches the visible text or the content description. */
function descriptorsFromSelector(selector: Record<string, unknown>): TargetDescriptor[] {
  const texts = [
    nonEmptyString(selector.text),
    ...(Array.isArray(selector.textAny) ? selector.textAny.map(nonEmptyString) : []),
  ].filter((text): text is string => text !== undefined);
  const resourceId = nonEmptyString(selector.elementId);
  return [
    ...texts.map((text) => ({ text, contentDesc: text })),
    ...(resourceId ? [{ resourceId }] : []),
  ];
}

/** swipeOn names its target through the innermost (last-resolved) nested container. */
function innermostContainer(args: Record<string, unknown>): Record<string, unknown> | undefined {
  let container = asRecord(args.container);
  for (let nested = asRecord(container?.container); nested; nested = asRecord(nested.container)) {
    container = nested;
  }
  return container;
}

function interactionSelector(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (toolName === "tapOn") {
    // Public tapOn nests the target in `selector`; Explore's own recording is flat.
    return asRecord(args.selector) ?? args;
  }
  return toolName === "swipeOn" ? innermostContainer(args) : undefined;
}

/**
 * Describe the element a recorded interaction addressed. `selectedElements` is
 * deliberately not consulted: it is the UI state observed BEFORE the action
 * (e.g. the active tab), which is a precondition, never the tap target.
 */
function describeInteractionTarget(edge: NavigationEdge): TargetDescriptors {
  const interaction = edge.interaction;
  if (!interaction) {
    return { reason: "no interaction was recorded for the edge, so there is no action to replay" };
  }
  const { toolName } = interaction;
  const selector = interactionSelector(toolName, interaction.args ?? {});
  if (!selector) {
    return {
      reason: `recorded "${toolName}" interaction does not address an element that can be replayed by tapping`,
    };
  }
  const descriptors = descriptorsFromSelector(selector);
  if (descriptors.length === 0) {
    return {
      reason: `recorded "${toolName}" interaction has no text or elementId selector to match on screen`,
    };
  }
  return { descriptors };
}

/** An edge recorded as a Back press (`pressButton { button: "back" }`). */
export function isRecordedBackEdge(edge: NavigationEdge): boolean {
  const interaction = edge.interaction;
  return interaction?.toolName === "pressButton" && interaction.args?.button === "back";
}

/** Coordinate containment is weaker evidence than a selector match on identity. */
const COORDINATE_CONFIDENCE = 0.7;

function boundsArea(element: Element): number {
  const { left, top, right, bottom } = element.bounds;
  return (right - left) * (bottom - top);
}

function boundsContain(element: Element, x: number, y: number): boolean {
  const { left, top, right, bottom } = element.bounds ?? {};
  // Non-finite or missing edges make every comparison false (NaN) or fail the check.
  return (
    [left, top, right, bottom].every(Number.isFinite) &&
    inRange(x, left, right) &&
    inRange(y, top, bottom)
  );
}

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

function notValidatable(edge: NavigationEdge, reason: string): EdgeTargetResolution {
  logger.warn(`[Explore] Edge ${edge.from}->${edge.to} is not validatable: ${reason}`);
  return { status: "not-validatable", reason };
}

/**
 * A recorded `tapAt {x, y}` can be replayed by tapping an element only if the
 * coordinate falls inside a current element's bounds (the smallest one wins);
 * otherwise there is nothing on screen to tap for it.
 */
function resolveCoordinateTap(
  elements: Element[],
  edge: NavigationEdge,
  args: Record<string, unknown>,
): EdgeTargetResolution {
  const { x, y } = args;
  if (typeof x !== "number" || typeof y !== "number") {
    return notValidatable(edge, 'recorded "tapAt" interaction has no numeric x/y coordinate');
  }
  const containing = elements.filter((element) => boundsContain(element, x, y));
  const [smallest] = containing.sort((a, b) => boundsArea(a) - boundsArea(b));
  if (!smallest) {
    return notValidatable(
      edge,
      `recorded "tapAt" coordinate (${x},${y}) is not inside any current element, so it cannot be replayed by tapping an element`,
    );
  }
  return { status: "matched", element: smallest, confidence: COORDINATE_CONFIDENCE };
}

/** Highest-scoring element for any descriptor; the first wins ties. */
function bestDescriptorMatch(
  elements: Element[],
  descriptors: TargetDescriptor[],
): { element: Element; confidence: number } | null {
  let best: { element: Element; confidence: number } | null = null;
  for (const element of elements) {
    for (const descriptor of descriptors) {
      const score = scoreSelectedElementMatch(element, descriptor);
      if (score > (best?.confidence ?? 0)) {
        best = { element, confidence: score };
      }
    }
  }
  return best;
}

/**
 * Resolve the on-screen element for a target edge from its recorded interaction
 * (`edge.interaction.args`). Never matches against `uiState.selectedElements`.
 */
export function resolveEdgeTarget(elements: Element[], edge: NavigationEdge): EdgeTargetResolution {
  if (isRecordedBackEdge(edge)) {
    return { status: "back" };
  }
  if (edge.interaction?.toolName === "tapAt") {
    return resolveCoordinateTap(elements, edge, edge.interaction.args ?? {});
  }
  const target = describeInteractionTarget(edge);
  if ("reason" in target) {
    return notValidatable(edge, target.reason);
  }

  const best = bestDescriptorMatch(elements, target.descriptors);
  if (best && best.confidence >= MIN_CONFIDENCE) {
    logger.debug(
      `[Explore] Matched element for edge ${edge.from}->${edge.to} with confidence ${best.confidence.toFixed(2)}`,
    );
    return { status: "matched", ...best };
  }

  const bestScore = best?.confidence ?? 0;
  logger.warn(
    `[Explore] No confident match for edge ${edge.from}->${edge.to} ` +
      `(best score: ${bestScore.toFixed(2)}, threshold: ${MIN_CONFIDENCE})`,
  );
  return { status: "not-found", bestScore };
}

/**
 * Find element on screen that matches a target edge's recorded interaction.
 * Returns null both when nothing matches and when the edge is not validatable;
 * use {@link resolveEdgeTarget} to tell those apart.
 */
export function findElementMatchingEdge(
  elements: Element[],
  edge: NavigationEdge,
): { element: Element; confidence: number } | null {
  const resolution = resolveEdgeTarget(elements, edge);
  return resolution.status === "matched"
    ? { element: resolution.element, confidence: resolution.confidence }
    : null;
}

/**
 * Validate that navigation matched expected edge in validate mode
 * Returns true if navigation succeeded, false if it diverged
 */
export async function validateNavigation(
  expectedEdge: NavigationEdge,
  state: GraphTraversalState,
  navigationManager: Pick<NavigationGraphService, "getCurrentScreen">,
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
