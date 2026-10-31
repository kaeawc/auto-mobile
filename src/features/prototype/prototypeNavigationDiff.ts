import type { ExportedGraph } from "../../utils/interfaces/NavigationGraph";
import type {
  PrototypeScreenEdgeAction,
  PrototypeScreenKind,
  PrototypeScreenMap,
  PrototypeScreenMapEdge,
  PrototypeScreenMapNode,
} from "./prototypeScreenMap";

/** The parts of a real app's navigation graph the diff reads. */
export interface RealNavigationGraph {
  screens: string[];
  transitions: { from: string; to: string }[];
}

export function realNavigationGraphFrom(graph: ExportedGraph): RealNavigationGraph {
  return {
    screens: graph.nodes.map((node) => node.screenName),
    transitions: graph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
  };
}

/** How a prototype screen found its real screen, in the order they are tried (#14125). */
export type PrototypeScreenMatchBy = "mapping" | "identifier" | "name";

export interface PrototypeNavigationDiff {
  matched: { prototype: string; real: string; by: PrototypeScreenMatchBy }[];
  /** Prototype screens with no real screen. `mappedScreenMissing`: the mapping names a screen the graph lacks. */
  unmatchedPrototypeScreens: {
    id: string;
    kind: PrototypeScreenKind;
    path: string;
    reason?: "mappedScreenMissing";
  }[];
  /** Real screens no prototype screen matched. */
  unmatchedRealScreens: string[];
  observedTransitions: {
    from: string;
    to: string;
    action: PrototypeScreenEdgeAction;
    real: { from: string; to: string };
  }[];
  /**
   * Prototype transitions the real graph does not show: `unmatchedScreen` when an end has no real
   * screen, `dynamicTarget` when the target is only known at runtime (a pop, a next/prev page),
   * `notObserved` when both ends match but no such real transition was recorded.
   */
  unobservedTransitions: (Pick<PrototypeScreenMapEdge, "from" | "to" | "action" | "trigger"> & {
    reason: "unmatchedScreen" | "dynamicTarget" | "notObserved";
  })[];
  /** Mapping keys that name no screen of the prototype. */
  ignoredMappings: string[];
}

const NAME_SUFFIX = /(screen|activity|fragment|page|viewcontroller|controller|view)$/;

/** Lower-case letters and digits only, without a trailing platform suffix: `DetailActivity` -> `detail`. */
const normalizeName = (name: string): string => {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const stripped = compact.replace(NAME_SUFFIX, "");
  return stripped === "" ? compact : stripped;
};

/** Authored names a screen goes by: its stack screen key, tab label or sheet/dialog id. */
function screenNames(node: PrototypeScreenMapNode): string[] {
  const names: string[] = [];
  if (node.label) {
    names.push(node.label);
  }
  if (node.kind === "stackScreen") {
    names.push(node.id.slice(node.id.lastIndexOf("/") + 1));
  } else if (node.kind === "sheet" || node.kind === "dialog") {
    const id = node.id.slice(node.id.indexOf(":") + 1);
    // An unnamed sheet or dialog is keyed by its spec path, which is not a name.
    if (id !== node.path) {
      names.push(id);
    }
  }
  return names;
}

type ScreenMatch = { real: string; by: PrototypeScreenMatchBy } | { missing: true } | undefined;

function matchScreen(
  node: PrototypeScreenMapNode,
  real: RealNavigationGraph,
  mapping: Readonly<Record<string, string>>,
): ScreenMatch {
  const mapped = mapping[node.id];
  if (mapped !== undefined) {
    return real.screens.includes(mapped) ? { real: mapped, by: "mapping" } : { missing: true };
  }
  if (node.testTag && real.screens.includes(node.testTag)) {
    return { real: node.testTag, by: "identifier" };
  }
  const wanted = new Set(screenNames(node).map(normalizeName));
  const byName = real.screens.find((screen) => wanted.has(normalizeName(screen)));
  return byName === undefined ? undefined : { real: byName, by: "name" };
}

/**
 * Compares a prototype's static screen map with a real app's navigation graph (#14125): which
 * prototype screens and transitions the app has, and which real screens the prototype lacks.
 * A screen matches through the explicit mapping (prototype screen id -> real screen name) first,
 * then its testTag as the real screen's identifier, then its authored name or tab label against
 * the real screen name, ignoring case, punctuation and a trailing Screen/Activity/Fragment-style
 * suffix. A mapped screen never falls back to the other rules.
 */
export function diffPrototypeNavigation(
  map: PrototypeScreenMap,
  real: RealNavigationGraph,
  mapping: Readonly<Record<string, string>> = {},
): PrototypeNavigationDiff {
  const known = new Set(map.nodes.map((node) => node.id));
  const screens = diffScreens(map.nodes, real, mapping);
  const claimed = new Set(screens.realOf.values());
  return {
    matched: screens.matched,
    unmatchedPrototypeScreens: screens.unmatched,
    unmatchedRealScreens: real.screens.filter((screen) => !claimed.has(screen)),
    ...diffTransitions(map.edges, real, { known, realOf: screens.realOf }),
    ignoredMappings: Object.keys(mapping).filter((id) => !known.has(id)),
  };
}

function diffScreens(
  nodes: readonly PrototypeScreenMapNode[],
  real: RealNavigationGraph,
  mapping: Readonly<Record<string, string>>,
) {
  const realOf = new Map<string, string>();
  const matched: PrototypeNavigationDiff["matched"] = [];
  const unmatched: PrototypeNavigationDiff["unmatchedPrototypeScreens"] = [];
  for (const node of nodes) {
    const match = matchScreen(node, real, mapping);
    if (match && "real" in match) {
      realOf.set(node.id, match.real);
      matched.push({ prototype: node.id, real: match.real, by: match.by });
    } else if (match || node.kind !== "root") {
      // The root is the whole prototype, not a destination: listed only when the mapping names it.
      unmatched.push({
        id: node.id,
        kind: node.kind,
        path: node.path,
        ...(match ? { reason: "mappedScreenMissing" as const } : {}),
      });
    }
  }
  return { realOf, matched, unmatched };
}

function diffTransitions(
  edges: readonly PrototypeScreenMapEdge[],
  real: RealNavigationGraph,
  { known, realOf }: { known: ReadonlySet<string>; realOf: ReadonlyMap<string, string> },
): Pick<PrototypeNavigationDiff, "observedTransitions" | "unobservedTransitions"> {
  const recorded = new Set(real.transitions.map((t) => JSON.stringify([t.from, t.to])));
  const result: Pick<PrototypeNavigationDiff, "observedTransitions" | "unobservedTransitions"> = {
    observedTransitions: [],
    unobservedTransitions: [],
  };
  for (const edge of edges) {
    const from = realOf.get(edge.from);
    const to = realOf.get(edge.to);
    const { from: edgeFrom, to: edgeTo, action, trigger } = edge;
    if (from !== undefined && to !== undefined && recorded.has(JSON.stringify([from, to]))) {
      result.observedTransitions.push({ from: edgeFrom, to: edgeTo, action, real: { from, to } });
      continue;
    }
    const reason = !known.has(edge.to)
      ? "dynamicTarget"
      : from === undefined || to === undefined
        ? "unmatchedScreen"
        : "notObserved";
    result.unobservedTransitions.push({ from: edgeFrom, to: edgeTo, action, trigger, reason });
  }
  return result;
}
