import type { NavigateToResult } from "../../models";
import type { NavigationEdge } from "../../utils/interfaces/NavigationGraph";
import { throwIfAborted } from "../../utils/toolUtils";
import type { NavigationGraphService } from "./NavigationGraphService";

/**
 * One recorded transition a navigateTo call must traverse as its final hop (#16982).
 * A transition is what `getNavigationGraph` lists as one edge: `from` → `to` via `toolName`.
 */
export interface TransitionPin {
  from: string;
  to: string;
  /** A `getNavigationGraph` edge id; selects that edge's tool when `toolName` is omitted. */
  edgeId?: number;
  /** The transition's tool; `null` selects an edge with no tool (a Back edge). */
  toolName?: string | null;
}

/** What a pinned navigation needs from `NavigateTo`. */
export interface PinnedNavigationHost {
  graph: Pick<
    NavigationGraphService,
    "getCurrentScreen" | "getEdgesFrom" | "exportGraphSummary" | "hasEdgeReplayFailure"
  >;
  now(): number;
  /** Unpinned navigateTo to `targetScreen`: any known path. */
  navigateTo(targetScreen: string): Promise<NavigateToResult>;
  /** Replay exactly `edge` once, with no fallback edge, and report whether it reached `edge.to`. */
  replayEdge(edge: NavigationEdge): Promise<NavigateToResult>;
}

type ToolSelector = { tool: string | null | undefined } | { missing: string };

function describePin(pin: TransitionPin): string {
  const via = pin.toolName === undefined ? "" : ` via ${pin.toolName ?? "Back"}`;
  return `"${pin.from}" → "${pin.to}"${via}`;
}

async function resolveToolSelector(
  pin: TransitionPin,
  graph: PinnedNavigationHost["graph"],
): Promise<ToolSelector> {
  if (pin.toolName !== undefined || pin.edgeId === undefined) {
    return { tool: pin.toolName };
  }
  const summary = await graph.exportGraphSummary();
  const listed = summary.edges.find(
    (edge) => edge.id === pin.edgeId && edge.from === pin.from && edge.to === pin.to,
  );
  return listed
    ? { tool: listed.toolName }
    : { missing: `Transition ${pin.edgeId} (${describePin(pin)}) is not in the navigation graph` };
}

function matchesTool(edge: NavigationEdge, tool: string | null | undefined): boolean {
  if (tool === undefined) {
    return true;
  }
  return (edge.interaction?.toolName ?? null) === tool;
}

/**
 * The recorded edge to replay for `pin`, or why there is none. Only edges for this exact
 * transition qualify; among them an edge with no failed replay ranks first, then the newest.
 */
export async function resolvePinnedEdge(
  pin: TransitionPin,
  graph: PinnedNavigationHost["graph"],
): Promise<NavigationEdge | string> {
  const selector = await resolveToolSelector(pin, graph);
  if ("missing" in selector) {
    return selector.missing;
  }
  const candidates = (await graph.getEdgesFrom(pin.from)).filter(
    (edge) =>
      edge.to === pin.to &&
      matchesTool(edge, selector.tool) &&
      (edge.interaction !== undefined || edge.edgeType === "back"),
  );
  const ranked = candidates
    .map((edge) => ({ edge, failed: graph.hasEdgeReplayFailure(edge) }))
    .sort((a, b) => Number(a.failed) - Number(b.failed) || b.edge.timestamp - a.edge.timestamp);
  return (
    ranked[0]?.edge ??
    `No replayable recorded transition ${describePin(pin)} in the navigation graph`
  );
}

function notReached(
  pin: TransitionPin,
  error: string,
  {
    currentScreen,
    startTime,
    path,
  }: { currentScreen: string | null; startTime: number; path: string[] },
  now: number,
): NavigateToResult {
  return {
    success: false,
    error,
    currentScreen,
    targetScreen: pin.to,
    stepsExecuted: path.length,
    partialPath: path,
    durationMs: now - startTime,
  };
}

function actionsOf(result: NavigateToResult): string[] {
  return result.path ?? result.partialPath ?? [];
}

function failureReason(result: NavigateToResult, fallback: string): string {
  return result.error ?? result.message ?? fallback;
}

/**
 * Navigate to `pin.from` by any known path, then replay exactly the pinned transition.
 * The final hop is never another edge: when the transition is missing or its replay does
 * not reach `pin.to`, the result is not reached, with the screen the device stopped on.
 */
export async function navigateViaTransition(
  pin: TransitionPin,
  host: PinnedNavigationHost,
  signal?: AbortSignal,
): Promise<NavigateToResult> {
  const startTime = host.now();
  const edge = await resolvePinnedEdge(pin, host.graph);
  throwIfAborted(signal);
  if (typeof edge === "string") {
    const currentScreen = host.graph.getCurrentScreen();
    return notReached(pin, edge, { currentScreen, startTime, path: [] }, host.now());
  }

  let leadIn: string[] = [];
  if (host.graph.getCurrentScreen() !== pin.from) {
    const toSource = await host.navigateTo(pin.from);
    throwIfAborted(signal);
    leadIn = actionsOf(toSource);
    if (!toSource.success) {
      const why = failureReason(toSource, "navigation did not arrive");
      return notReached(
        pin,
        `Did not reach the transition's source "${pin.from}" before replaying ${describePin(pin)}: ${why}`,
        { currentScreen: toSource.currentScreen, startTime, path: leadIn },
        host.now(),
      );
    }
  }

  const replay = await host.replayEdge(edge);
  throwIfAborted(signal);
  const path = [...leadIn, ...actionsOf(replay)];
  if (!replay.success) {
    const why = failureReason(replay, "the replay did not arrive");
    return notReached(
      pin,
      `Replaying ${describePin(pin)} did not reach "${pin.to}": ${why}`,
      { currentScreen: replay.currentScreen, startTime, path },
      host.now(),
    );
  }
  return {
    success: true,
    message: `Navigated to "${pin.to}" along ${describePin(pin)}`,
    currentScreen: pin.to,
    targetScreen: pin.to,
    stepsExecuted: path.length,
    path,
    durationMs: host.now() - startTime,
  };
}
