import { isFailedNetworkRequest } from "../utils/networkRequestOutcome";
import type { NetworkEventWithId } from "../db/networkEventRepository";
import { computePercentile } from "../utils/percentile";
import { logger } from "../utils/logger";

export interface GraphLeaf {
  method?: string;
  type?: string;
  success: number;
  errors: number;
  p50: number;
  p95: number;
}

export interface GraphBranch {
  parameterized?: boolean;
  paths: Record<string, GraphNode>;
}

export type GraphNode = GraphLeaf | GraphBranch | (GraphLeaf & GraphBranch);

export interface GraphHost {
  scheme: string;
  host: string;
  paths: Record<string, GraphNode>;
}

export interface NetworkGraph {
  graph: GraphHost[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_PATTERN = /^[0-9a-f]{8,}$/i;

function isParameterizedSegment(segment: string): boolean {
  if (/^\d+$/.test(segment)) {
    return true;
  }
  if (UUID_PATTERN.test(segment)) {
    return true;
  }
  if (HEX_PATTERN.test(segment)) {
    return true;
  }
  return false;
}

interface EventGroup {
  method: string;
  contentType: string | null | undefined;
  durations: number[];
  success: number;
  errors: number;
}

/** One method on one raw path. The path is stored, not re-derived from a joined key. */
interface PathGroup extends EventGroup {
  path: string;
}

type HostEntry = {
  scheme: string;
  /** Host label; carries `:port` only when the port is not the scheme's default. */
  host: string;
  pathGroups: Map<string, PathGroup>;
};

/**
 * Map keys are JSON-encoded tuples: unlike a delimiter join, no component's content
 * (a `::` in a path, a `:` in a host) can make two distinct tuples collide.
 */
function tupleKey(...parts: string[]): string {
  return JSON.stringify(parts);
}

function accumulateEvent(hostMap: Map<string, HostEntry>, event: NetworkEventWithId): void {
  let scheme = "https";
  let host = event.host ?? "unknown";

  if (event.url) {
    try {
      const parsed = new URL(event.url);
      scheme = parsed.protocol.replace(":", "");
      // `URL.port` is "" for the scheme's default port, so default-port hosts keep the
      // bare hostname label while a non-default port gets its own host entry.
      host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    } catch {
      // Captured URLs may be malformed; the event host still supplies a usable graph fallback.
      logger.debug("Network graph URL could not be parsed; using fallback host");
    }
  }

  const hostKey = tupleKey(scheme, host);
  let entry = hostMap.get(hostKey);
  if (!entry) {
    entry = { scheme, host, pathGroups: new Map() };
    hostMap.set(hostKey, entry);
  }

  const path = event.path ?? "/";
  const groupKey = tupleKey(path, event.method);

  let group = entry.pathGroups.get(groupKey);
  if (!group) {
    group = {
      path,
      method: event.method,
      contentType: event.contentType,
      durations: [],
      success: 0,
      errors: 0,
    };
    entry.pathGroups.set(groupKey, group);
  }

  group.durations.push(event.durationMs);
  if (isFailedNetworkRequest(event)) {
    group.errors++;
  } else {
    group.success++;
  }
}

function insertPathGroups(
  root: Record<string, GraphNode>,
  pathGroups: Map<string, PathGroup>,
): void {
  for (const group of pathGroups.values()) {
    const segments = group.path.split("/").filter((s) => s.length > 0);
    const sorted = [...group.durations].sort((a, b) => a - b);
    const leaf: GraphLeaf & { _durations?: number[] } = {
      method: group.method,
      type: group.contentType ?? undefined,
      success: group.success,
      errors: group.errors,
      p50: Math.round(computePercentile(sorted, 50)),
      p95: Math.round(computePercentile(sorted, 95)),
      _durations: group.durations,
    };

    insertIntoTree(root, segments, 0, leaf);
  }
}

export function buildNetworkGraph(
  events: NetworkEventWithId[],
  options: { minRequests?: number } = {},
): NetworkGraph {
  const minRequests = options.minRequests ?? 1;

  // Group events by scheme+host(+non-default port)+path+method
  const hostMap = new Map<string, HostEntry>();

  for (const event of events) {
    accumulateEvent(hostMap, event);
  }

  const result: GraphHost[] = [];

  for (const [, { scheme, host, pathGroups }] of hostMap) {
    const root: Record<string, GraphNode> = createPathNode();

    insertPathGroups(root, pathGroups);
    // minRequests is evaluated on the aggregated (parameterized) endpoint, the unit the
    // graph reports, so it must run after `{id}` collapse rather than per raw URL (#9917).
    pruneBelowMinRequests(root, minRequests);

    if (Object.keys(root).length > 0) {
      stripDurations(root);
      result.push({ scheme, host, paths: root });
    }
  }

  return { graph: result };
}

function mergeLeafStats(
  target: GraphLeaf & { _durations?: number[] },
  source: GraphLeaf & { _durations?: number[] },
): void {
  target.success = (target.success ?? 0) + source.success;
  target.errors = (target.errors ?? 0) + source.errors;
  const combined = [...(target._durations ?? []), ...(source._durations ?? [])];
  target._durations = combined;
  const sorted = [...combined].sort((a, b) => a - b);
  target.p50 = Math.round(computePercentile(sorted, 50));
  target.p95 = Math.round(computePercentile(sorted, 95));
}

const LEAF_STAT_KEYS = ["method", "type", "success", "errors", "p50", "p95", "_durations"] as const;

function dropLeafStats(node: GraphLeaf & Partial<GraphBranch> & { _durations?: number[] }): void {
  for (const key of LEAF_STAT_KEYS) {
    delete node[key];
  }
}

/**
 * Remove leaves whose merged request count is under `minRequests`, then branches left
 * with no leaves. A combined leaf+branch node keeps its children when only its own
 * stats fall below the threshold.
 */
function pruneBelowMinRequests(node: Record<string, GraphNode>, minRequests: number): void {
  for (const key of Object.keys(node)) {
    const val = node[key] as GraphLeaf & Partial<GraphBranch> & { _durations?: number[] };
    if (val.paths) {
      pruneBelowMinRequests(val.paths, minRequests);
      if (Object.keys(val.paths).length === 0) {
        delete val.paths;
      }
    }
    if (val.success !== undefined && val.success + val.errors < minRequests) {
      dropLeafStats(val);
    }
    if (val.success === undefined && !val.paths) {
      delete node[key];
    }
  }
}

function stripDurations(node: Record<string, GraphNode>): void {
  for (const key of Object.keys(node)) {
    const val = node[key] as GraphNode & { _durations?: number[] };
    if (val._durations) {
      delete val._durations;
    }
    if ("paths" in val && val.paths) {
      stripDurations(val.paths);
    }
  }
}

/**
 * Path-tree nodes are keyed by URL path segments, which are attacker/app controlled.
 * A `{}` map inherits `Object.prototype`, so a segment named `constructor`,
 * `toString`, `__proto__`, ... reads back as the inherited member and the
 * `!node[key]` guard below never creates the branch — writing `paths` onto the
 * global `Object` constructor / `Object.prototype` instead (issue #4187).
 */
function createPathNode(): Record<string, GraphNode> {
  return Object.create(null) as Record<string, GraphNode>;
}

function insertLeaf(
  node: Record<string, GraphNode>,
  key: string,
  isParam: boolean,
  leaf: GraphLeaf,
): void {
  // Leaf position — key includes method to separate GET/POST/etc on the same path
  const leafKey = leaf.method ? `${key}[${leaf.method}]` : key;
  const existing = node[leafKey];
  if (existing && "success" in existing) {
    // Merge stats with percentile recomputation (parameterized path collapse)
    mergeLeafStats(existing as GraphLeaf & { _durations?: number[] }, leaf);
  } else if (existing && "paths" in existing) {
    // Existing branch — add stats to branch node (becomes a combined leaf+branch)
    const combined = existing as GraphLeaf & GraphBranch & { _durations?: number[] };
    mergeLeafStats(combined, leaf);
    combined.method = leaf.method;
    combined.type = leaf.type;
  } else {
    node[leafKey] = leaf;
    if (isParam) {
      (node[leafKey] as GraphLeaf & { parameterized?: boolean }).parameterized = true;
    }
  }
}

function insertIntoTree(
  node: Record<string, GraphNode>,
  segments: string[],
  index: number,
  leaf: GraphLeaf,
): void {
  if (index >= segments.length) {
    // Root path "/" case — put stats directly
    const existing = node[""] as (GraphLeaf & { _durations?: number[] }) | undefined;
    if (existing && "success" in existing) {
      mergeLeafStats(existing, leaf);
    } else {
      node[""] = leaf;
    }
    return;
  }

  const segment = segments[index];
  const isParam = isParameterizedSegment(segment);
  const key = isParam ? "{id}" : segment;

  if (index === segments.length - 1) {
    insertLeaf(node, key, isParam, leaf);
  } else {
    // Branch position
    if (!node[key]) {
      node[key] = { paths: createPathNode() } as GraphBranch;
      if (isParam) {
        (node[key] as GraphBranch).parameterized = true;
      }
    }
    const branch = node[key] as GraphBranch;
    if (!branch.paths) {
      branch.paths = createPathNode();
    }
    insertIntoTree(branch.paths, segments, index + 1, leaf);
  }
}
