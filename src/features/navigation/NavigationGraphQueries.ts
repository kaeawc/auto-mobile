import type {
  NavigationEdgeProvenanceRow,
  NavigationEdgeTarget,
  NavigationNodeProvenanceRow,
} from "../../db/navigationRepository";
import { NavigationRepository } from "../../db/navigationRepository";
import type {
  NavigationEdge as DBNavigationEdge,
  NavigationNode as DBNavigationNode,
} from "../../db/types";
import { stripNavigationToolParams } from "../../models/navigationToolParams";
import {
  ExportedGraph,
  NavigationAppSummary,
  NavigationEdge,
  NavigationGraphHistoryEdge,
  NavigationGraphHistoryNode,
  NavigationGraphHistoryPage,
  NavigationGraphNodeDetail,
  NavigationGraphNodeResource,
  NavigationGraphStats,
  NavigationGraphSummary,
  NavigationGraphSummaryEdge,
  NavigationGraphSummaryNode,
  NavigationNode,
  NavigationProvenanceRecord,
  NavigationSuggestionInfo,
  PathResult,
  ScrollPosition,
  ToolCallInteraction,
} from "../../utils/interfaces/NavigationGraph";
import { buildNavigationNodeScreenshotUri } from "../../utils/navigationResourceUri";

/** Whether replaying this stored edge is remembered as having failed (#10031). */
type IsReplayFailed = (edge: DBNavigationEdge) => boolean;

/**
 * Whether `candidate` should replace `existing` as the edge used for a screen
 * pair during path finding (#9990, #10031). Each carries a tool call or is a
 * Back edge (any other edge with none is not replayable and never reaches here,
 * #10196). Order of preference:
 * 1. an edge whose replay has not failed over one remembered as failing, so a
 *    bad tool edge cannot shadow a working edge (including a recorded Back);
 * 2. the most recent row. Row id decides before the device event timestamp:
 *    ids only grow, while device clocks can move backwards.
 */
function isPreferredPathEdge(
  candidate: DBNavigationEdge,
  existing: DBNavigationEdge,
  isReplayFailed: IsReplayFailed,
): boolean {
  const candidateFailed = isReplayFailed(candidate);
  if (candidateFailed !== isReplayFailed(existing)) {
    return !candidateFailed;
  }
  if (candidate.id !== existing.id) {
    return candidate.id > existing.id;
  }
  return candidate.timestamp > existing.timestamp;
}

/** Recorded back-stack depth per screen name; a screen never observed with one is absent. */
type BackStackDepths = ReadonlyMap<string, number>;

/**
 * Whether an edge with no tool call is evidence of a Back press (#10196): its target was
 * recorded at a shallower back-stack depth than its source, which is what popping one entry
 * does (the same signal `shouldUseBackButton` acts on). Unknown depths (iOS, never observed
 * with a back stack), or the same or a deeper target, say nothing about what caused the edge.
 */
function isBackEdge(edge: DBNavigationEdge, depths: BackStackDepths): boolean {
  if (edge.tool_name !== null) {
    return false;
  }
  const sourceDepth = depths.get(edge.from_screen);
  const targetDepth = depths.get(edge.to_screen);
  return sourceDepth !== undefined && targetDepth !== undefined && targetDepth < sourceDepth;
}

/**
 * Index the replayable edges by source screen, keeping one edge per (from, to)
 * pair: every traversal inserts a new row. See #9990.
 *
 * An edge with no tool call is replayable only as Back, and only with evidence that Back
 * caused it (#10196): a target shallower than its source in the recorded back-stack depth.
 * Without that, nothing says what caused it and replaying a Back press would be a guess, so
 * the edge is skipped here, path finding routes around it, and it is counted so a failed
 * search can say so.
 */
function indexPathEdgesBySource(
  dbEdges: DBNavigationEdge[],
  isReplayFailed: IsReplayFailed,
  backDepths: BackStackDepths,
): { edgesBySource: Map<string, Map<string, DBNavigationEdge>>; unreplayableEdges: number } {
  const edgesBySource = new Map<string, Map<string, DBNavigationEdge>>();
  let unreplayableEdges = 0;
  for (const edge of dbEdges) {
    if (edge.tool_name === null && !isBackEdge(edge, backDepths)) {
      unreplayableEdges++;
      continue;
    }
    const source = edge.from_screen;
    let outgoingEdges = edgesBySource.get(source);
    if (!outgoingEdges) {
      outgoingEdges = new Map<string, DBNavigationEdge>();
      edgesBySource.set(source, outgoingEdges);
    }
    const existing = outgoingEdges.get(edge.to_screen);
    if (!existing || isPreferredPathEdge(edge, existing, isReplayFailed)) {
      outgoingEdges.set(edge.to_screen, edge);
    }
  }
  return { edgesBySource, unreplayableEdges };
}

async function loadEdgeInteraction(
  repository: NavigationRepository,
  dbEdge: DBNavigationEdge,
  toolName: string,
): Promise<ToolCallInteraction> {
  const interaction: ToolCallInteraction = {
    toolName,
    args: stripNavigationToolParams(dbEdge.tool_args ? JSON.parse(dbEdge.tool_args) : {}),
    timestamp: dbEdge.timestamp,
  };

  // Load UI elements
  const uiElements = await repository.getUIElementsForEdge(dbEdge.id);
  if (uiElements.length > 0) {
    interaction.uiState = {
      selectedElements: uiElements.map((el) => ({
        text: el.text || undefined,
        resourceId: el.resource_id || undefined,
        contentDesc: el.content_description || undefined,
      })),
    };
  }

  // Load scroll position
  const scrollPos = await repository.getScrollPosition(dbEdge.id);
  if (scrollPos) {
    // Initialize uiState if not already present
    if (!interaction.uiState) {
      interaction.uiState = {
        selectedElements: [],
      };
    }
    interaction.uiState.scrollPosition = convertDBScrollPosition(scrollPos);
  }
  return interaction;
}

function convertDBScrollPosition(
  scrollPos: NonNullable<Awaited<ReturnType<NavigationRepository["getScrollPosition"]>>>,
): ScrollPosition {
  const position: ScrollPosition = {
    targetElement: {
      text: scrollPos.targetElement.text || undefined,
      resourceId: scrollPos.targetElement.resource_id || undefined,
      contentDesc: scrollPos.targetElement.content_description || undefined,
    },
    direction: scrollPos.direction as "up" | "down" | "left" | "right",
    speed: scrollPos.speed as "slow" | "normal" | "fast" | undefined,
  };

  // Add container if present
  if (scrollPos.containerElement) {
    position.container = {
      text: scrollPos.containerElement.text || undefined,
      resourceId: scrollPos.containerElement.resource_id || undefined,
      contentDesc: scrollPos.containerElement.content_description || undefined,
    };
  }
  return position;
}

type HistoryCursor = {
  timestamp: number;
  id: number;
};

/**
 * Composite identity of a single provenance observation, used to dedup records
 * unioned across the multiple edge rows that aggregate into one summary transition
 * (#4985). Nodes never need this (one node_id → one summary node), but edges do.
 */
function provenanceDedupKey(record: NavigationProvenanceRecord): string {
  const { packageId, versionCode, contentHash } = record.buildKey;
  return `${packageId}\u0000${versionCode}\u0000${contentHash}\u0000${record.deviceId}\u0000${record.sessionUuid}`;
}

/** Deterministic recency-first ordering: newest lastSeen, then build/device/session. */
function compareProvenanceRecords(
  a: NavigationProvenanceRecord,
  b: NavigationProvenanceRecord,
): number {
  if (a.lastSeen !== b.lastSeen) {
    return b.lastSeen - a.lastSeen;
  }
  if (a.buildKey.packageId !== b.buildKey.packageId) {
    return a.buildKey.packageId < b.buildKey.packageId ? -1 : 1;
  }
  if (a.buildKey.versionCode !== b.buildKey.versionCode) {
    return b.buildKey.versionCode - a.buildKey.versionCode;
  }
  if (a.buildKey.contentHash !== b.buildKey.contentHash) {
    return a.buildKey.contentHash < b.buildKey.contentHash ? -1 : 1;
  }
  if (a.deviceId !== b.deviceId) {
    return a.deviceId < b.deviceId ? -1 : 1;
  }
  if (a.sessionUuid !== b.sessionUuid) {
    return a.sessionUuid < b.sessionUuid ? -1 : 1;
  }
  return 0;
}

function nodeProvenanceRowToRecord(row: NavigationNodeProvenanceRow): NavigationProvenanceRecord {
  return {
    buildKey: {
      packageId: row.package_id,
      versionCode: row.version_code,
      contentHash: row.content_hash,
    },
    deviceId: row.device_id,
    sessionUuid: row.session_uuid,
    lastSeen: row.last_seen_at,
  };
}

function edgeProvenanceRowToRecord(row: NavigationEdgeProvenanceRow): NavigationProvenanceRecord {
  return {
    buildKey: {
      packageId: row.package_id,
      versionCode: row.version_code,
      contentHash: row.content_hash,
    },
    deviceId: row.device_id,
    sessionUuid: row.session_uuid,
    lastSeen: row.last_seen_at,
  };
}

/** Group node-observation join rows into a per-node provenance map (#4985). */
function groupNodeProvenance(
  rows: NavigationNodeProvenanceRow[],
): Map<number, NavigationProvenanceRecord[]> {
  const byNodeId = new Map<number, NavigationProvenanceRecord[]>();
  for (const row of rows) {
    const bucket = byNodeId.get(row.node_id);
    const record = nodeProvenanceRowToRecord(row);
    if (bucket) {
      bucket.push(record);
    } else {
      byNodeId.set(row.node_id, [record]);
    }
  }
  for (const records of byNodeId.values()) {
    records.sort(compareProvenanceRecords);
  }
  return byNodeId;
}

/** Group edge-observation join rows into a per-edge-row provenance map (#4985). */
function groupEdgeProvenance(
  rows: NavigationEdgeProvenanceRow[],
): Map<number, NavigationProvenanceRecord[]> {
  const byEdgeId = new Map<number, NavigationProvenanceRecord[]>();
  for (const row of rows) {
    const bucket = byEdgeId.get(row.edge_id);
    const record = edgeProvenanceRowToRecord(row);
    if (bucket) {
      bucket.push(record);
    } else {
      byEdgeId.set(row.edge_id, [record]);
    }
  }
  return byEdgeId;
}

/**
 * Dedup provenance records (keeping the max lastSeen per identity) and return them
 * in deterministic recency-first order. Used when unioning provenance across the
 * edge rows that collapse into one summary transition (#4985).
 */
function mergeProvenanceRecords(
  records: NavigationProvenanceRecord[],
): NavigationProvenanceRecord[] {
  const byKey = new Map<string, NavigationProvenanceRecord>();
  for (const record of records) {
    const key = provenanceDedupKey(record);
    const existing = byKey.get(key);
    if (!existing || record.lastSeen > existing.lastSeen) {
      byKey.set(key, record);
    }
  }
  return Array.from(byKey.values()).sort(compareProvenanceRecords);
}
interface NavigationGraphQueryContext {
  getCurrentAppId(): string | null;
  getCurrentScreen(): string | null;
  getToolCallHistorySize(): number;
  isEdgeReplayFailed(appId: string | null, edge: DBNavigationEdge): boolean;
}
/** Graph hydration, path finding, resources and history over the injected repository. */
export class NavigationGraphQueries {
  private readonly HISTORY_PAGE_DEFAULT = 50;
  private readonly HISTORY_PAGE_MAX = 200;
  constructor(
    private readonly repository: NavigationRepository,
    private readonly context: NavigationGraphQueryContext,
  ) {}
  private get currentAppId(): string | null {
    return this.context.getCurrentAppId();
  }
  private get currentScreen(): string | null {
    return this.context.getCurrentScreen();
  }

  /**
   * Find the shortest path from current screen to target screen using BFS.
   */
  public async findPath(targetScreen: string): Promise<PathResult> {
    if (!this.currentAppId || !this.currentScreen) {
      return {
        found: false,
        path: [],
        startScreen: "",
        targetScreen,
      };
    }

    const startScreen = this.currentScreen;

    if (startScreen === targetScreen) {
      return {
        found: true,
        path: [],
        startScreen,
        targetScreen,
      };
    }

    // Distinct transitions for BFS: path finding must not load every traversal row (#10194)
    const dbEdges = await this.repository.getDistinctEdges(this.currentAppId);

    const appId = this.currentAppId;
    const backDepths = await this.loadBackStackDepths(appId, dbEdges);
    const { edgesBySource, unreplayableEdges } = indexPathEdgesBySource(
      dbEdges,
      (edge) => this.context.isEdgeReplayFailed(appId, edge),
      backDepths,
    );

    // BFS to find shortest path
    const queue: string[] = [startScreen];
    let queueHead = 0;
    const visited = new Set<string>([startScreen]);
    const predecessor = new Map<string, DBNavigationEdge>();

    while (queueHead < queue.length) {
      const screen = queue[queueHead++];
      const outgoingEdges = edgesBySource.get(screen)?.values() ?? [];

      for (const edge of outgoingEdges) {
        if (edge.to_screen === targetScreen) {
          predecessor.set(edge.to_screen, edge);
          const pathEdges = await this.convertDBEdgesToNavigationEdges(
            this.reconstructPath(startScreen, targetScreen, predecessor),
            backDepths,
          );

          // Found the target
          return {
            found: true,
            path: pathEdges,
            startScreen,
            targetScreen,
          };
        }

        if (!visited.has(edge.to_screen)) {
          visited.add(edge.to_screen);
          predecessor.set(edge.to_screen, edge);
          queue.push(edge.to_screen);
        }
      }
    }

    // No path found
    return {
      found: false,
      path: [],
      startScreen,
      targetScreen,
      ...(unreplayableEdges > 0 ? { unreplayableEdges } : {}),
    };
  }

  /**
   * The recorded back-stack depth of each screen, read only when an edge with no tool call
   * needs it: those edges are replayable as Back only with depth evidence (#10196).
   */
  private async loadBackStackDepths(
    appId: string,
    dbEdges: DBNavigationEdge[],
  ): Promise<BackStackDepths> {
    const depths = new Map<string, number>();
    if (!dbEdges.some((edge) => edge.tool_name === null)) {
      return depths;
    }
    for (const node of await this.repository.getNodes(appId)) {
      if (node.back_stack_depth !== null) {
        depths.set(node.screen_name, node.back_stack_depth);
      }
    }
    return depths;
  }

  private reconstructPath(
    startScreen: string,
    targetScreen: string,
    predecessor: Map<string, DBNavigationEdge>,
  ): DBNavigationEdge[] {
    const path: DBNavigationEdge[] = [];
    let screen = targetScreen;

    while (screen !== startScreen) {
      const edge = predecessor.get(screen);
      if (!edge) {
        return [];
      }

      path.push(edge);
      screen = edge.from_screen;
    }

    return path.reverse();
  }

  /**
   * Convert database edges to NavigationEdge format.
   */
  private async convertDBEdgesToNavigationEdges(
    dbEdges: DBNavigationEdge[],
    // Present only for a path found by findPath: it names the edges replayable as Back.
    backDepths?: BackStackDepths,
  ): Promise<NavigationEdge[]> {
    const edges: NavigationEdge[] = [];

    for (const dbEdge of dbEdges) {
      const edge: NavigationEdge = {
        from: dbEdge.from_screen,
        to: dbEdge.to_screen,
        timestamp: dbEdge.timestamp,
        edgeType: dbEdge.tool_name
          ? "tool"
          : backDepths && isBackEdge(dbEdge, backDepths)
            ? "back"
            : "unknown",
      };

      if (dbEdge.tool_name) {
        edge.interaction = await loadEdgeInteraction(this.repository, dbEdge, dbEdge.tool_name);

        // Copy interaction.uiState to edge.uiState for backward compatibility
        if (edge.interaction.uiState) {
          edge.uiState = edge.interaction.uiState;
        }
      }

      // Load modal stacks
      const fromModals = await this.repository.getEdgeModals(dbEdge.id, "from");
      const toModals = await this.repository.getEdgeModals(dbEdge.id, "to");

      if (fromModals.length > 0) {
        edge.fromModalStack = fromModals.map((id, layer) => ({
          type: "overlay" as const,
          identifier: id,
          layer,
        }));
      }

      if (toModals.length > 0) {
        edge.toModalStack = toModals.map((id, layer) => ({
          type: "overlay" as const,
          identifier: id,
          layer,
        }));
      }

      edges.push(edge);
    }

    return edges;
  }

  private async buildNodeDetail(dbNode: DBNavigationNode): Promise<NavigationGraphNodeDetail> {
    return { id: dbNode.id, ...(await this.buildNodeBody(dbNode)) };
  }

  /** A node's detail without its database id (the shape served by the node resource). */
  private async buildNodeBody(
    dbNode: DBNavigationNode,
  ): Promise<Omit<NavigationGraphNodeDetail, "id">> {
    const modals = await this.repository.getNodeModals(dbNode.id);

    return {
      screenName: dbNode.screen_name,
      firstSeenAt: dbNode.first_seen_at,
      lastSeenAt: dbNode.last_seen_at,
      visitCount: dbNode.visit_count,
      backStackDepth: dbNode.back_stack_depth ?? undefined,
      taskId: dbNode.task_id ?? undefined,
      modalStack:
        modals.length > 0
          ? modals.map((id, layer) => ({
              type: "overlay" as const,
              identifier: id,
              layer,
            }))
          : undefined,
    };
  }

  private async buildNodeResource(
    dbNode: DBNavigationNode,
    appId: string,
  ): Promise<NavigationGraphNodeResource> {
    const [node, dbEdgesFrom, dbEdgesTo] = await Promise.all([
      this.buildNodeDetail(dbNode),
      this.repository.getEdgesFrom(appId, dbNode.screen_name),
      this.repository.getEdgesTo(appId, dbNode.screen_name),
    ]);

    const [edgesFrom, edgesTo] = await Promise.all([
      this.convertDBEdgesToNavigationEdges(dbEdgesFrom),
      this.convertDBEdgesToNavigationEdges(dbEdgesTo),
    ]);

    return {
      appId,
      node,
      // Only the current app's current screen is "current"; a node read under an
      // explicit app that is not foregrounded is never the current screen (#4933).
      isCurrentScreen: appId === this.currentAppId && this.currentScreen === dbNode.screen_name,
      edgesFrom,
      edgesTo,
    };
  }

  /**
   * Get all known screen names.
   */
  public async getKnownScreens(): Promise<string[]> {
    if (!this.currentAppId) {
      return [];
    }

    const nodes = await this.repository.getNodes(this.currentAppId);
    return nodes.map((n) => n.screen_name);
  }

  /**
   * Get a specific node by screen name.
   */
  public async getNode(screenName: string): Promise<NavigationNode | undefined> {
    if (!this.currentAppId) {
      return undefined;
    }

    const dbNode = await this.repository.getNode(this.currentAppId, screenName);
    if (!dbNode) {
      return undefined;
    }

    return await this.buildNodeBody(dbNode);
  }

  /**
   * Get a node resource by node ID.
   */
  public async getNodeResourceById(
    nodeId: number,
    appId?: string,
  ): Promise<NavigationGraphNodeResource | null> {
    // Prefer an explicit app so a persisted node can be read while a different
    // app (or none) is foregrounded; fall back to the current app (#4933).
    const resolvedAppId = appId ?? this.currentAppId;
    if (!resolvedAppId) {
      return null;
    }

    const dbNode = await this.repository.getNodeById(resolvedAppId, nodeId);
    if (!dbNode) {
      return null;
    }

    return this.buildNodeResource(dbNode, resolvedAppId);
  }

  /**
   * Get a node resource by screen name.
   */
  public async getNodeResourceByScreen(
    screenName: string,
  ): Promise<NavigationGraphNodeResource | null> {
    if (!this.currentAppId) {
      return null;
    }

    const dbNode = await this.repository.getNode(this.currentAppId, screenName);
    if (!dbNode) {
      return null;
    }

    return this.buildNodeResource(dbNode, this.currentAppId);
  }

  /**
   * Get all edges from a specific screen.
   */
  public async getEdgesFrom(screenName: string): Promise<NavigationEdge[]> {
    if (!this.currentAppId) {
      return [];
    }

    const dbEdges = await this.repository.getEdgesFrom(this.currentAppId, screenName);
    return this.convertDBEdgesToNavigationEdges(dbEdges);
  }

  /**
   * Distinct outgoing transitions of a screen for graph walks that only need
   * adjacency; unlike getEdgesFrom this does not hydrate interactions, modals or
   * scroll positions, so it cannot throw on a malformed edge payload.
   */
  public async getEdgeTargetsFrom(screenName: string): Promise<NavigationEdgeTarget[]> {
    if (!this.currentAppId) {
      return [];
    }

    return this.repository.getEdgeTargetsFrom(this.currentAppId, screenName);
  }

  /**
   * Get all edges to a specific screen.
   */
  public async getEdgesTo(screenName: string): Promise<NavigationEdge[]> {
    if (!this.currentAppId) {
      return [];
    }

    const dbEdges = await this.repository.getEdgesTo(this.currentAppId, screenName);
    return this.convertDBEdgesToNavigationEdges(dbEdges);
  }

  /**
   * Get graph statistics for a specific app without changing the active graph.
   */
  public async getStatsForApp(appId: string | null): Promise<NavigationGraphStats> {
    if (!appId) {
      return {
        nodeCount: 0,
        edgeCount: 0,
        currentScreen: null,
        knownEdgeCount: 0,
        unknownEdgeCount: 0,
        toolCallHistorySize: 0,
      };
    }

    const stats = await this.repository.getStats(appId);
    const isCurrentApp = appId === this.currentAppId;

    return {
      nodeCount: stats.nodeCount,
      edgeCount: stats.edgeCount,
      currentScreen: isCurrentApp ? this.currentScreen : null,
      knownEdgeCount: stats.toolEdgeCount,
      unknownEdgeCount: stats.unknownEdgeCount,
      toolCallHistorySize: isCurrentApp ? this.context.getToolCallHistorySize() : 0,
    };
  }

  /**
   * Export a specific app's graph without changing the active graph.
   */
  public async exportGraphForApp(appId: string | null): Promise<ExportedGraph> {
    if (!appId) {
      return {
        appId: null,
        nodes: [],
        edges: [],
        currentScreen: null,
      };
    }

    const dbNodes = await this.repository.getNodes(appId);
    // One edge per distinct transition (newest traversal's metadata), not per traversal (#10194)
    const dbEdges = await this.repository.getDistinctEdges(appId);

    const nodes: NavigationNode[] = [];
    for (const dbNode of dbNodes) {
      const modals = await this.repository.getNodeModals(dbNode.id);
      nodes.push({
        screenName: dbNode.screen_name,
        firstSeenAt: dbNode.first_seen_at,
        lastSeenAt: dbNode.last_seen_at,
        visitCount: dbNode.visit_count,
        modalStack:
          modals.length > 0
            ? modals.map((id, layer) => ({
                type: "overlay" as const,
                identifier: id,
                layer,
              }))
            : undefined,
      });
    }

    const edges = await this.convertDBEdgesToNavigationEdges(dbEdges);

    return {
      appId,
      nodes,
      edges,
      currentScreen: appId === this.currentAppId ? this.currentScreen : null,
    };
  }

  /**
   * List every app that has a persisted navigation graph, ordered by the app
   * record's `navigation_apps.updated_at` (newest first). Device-independent
   * (reads persisted rows only) so the desktop can populate an offline app
   * picker. displayName is null: the persisted schema has no display-name column
   * (see NavigationAppSummary). Note that `updated_at` is not bumped by every
   * graph mutation, so both `lastUpdated` and this ordering can lag some changes
   * (issue #4931).
   */
  public async listAppsWithGraph(): Promise<NavigationAppSummary[]> {
    const apps = await this.repository.listApps();
    return apps.map((app) => ({
      appId: app.app_id,
      displayName: null,
      lastUpdated: app.updated_at,
    }));
  }

  /**
   * Export a high-level graph summary for a specific app.
   * Edges are aggregated by (from, to, toolName) with traversal counts.
   * @param appId The app ID to export the graph for, or null for empty graph.
   */
  public async exportGraphSummaryForApp(appId: string | null): Promise<NavigationGraphSummary> {
    if (!appId) {
      return {
        appId: null,
        nodes: [],
        edges: [],
        currentScreen: null,
      };
    }

    const dbNodes = await this.repository.getNodes(appId);
    const dbEdges = await this.repository.getEdges(appId);

    // Provenance (#4985): one typed join each for node/edge observations, grouped
    // in-memory. Attached additively so pre-provenance consumers are unaffected.
    const nodeProvenanceByNodeId = groupNodeProvenance(
      await this.repository.getNodeProvenanceForApp(appId),
    );
    const edgeProvenanceByEdgeId = groupEdgeProvenance(
      await this.repository.getEdgeProvenanceForApp(appId),
    );

    const nodes: NavigationGraphSummaryNode[] = dbNodes.map((node) => ({
      id: node.id,
      screenName: node.screen_name,
      visitCount: node.visit_count,
      // Include screenshot path as resource URI if available, scoped to the
      // exported app so an offline / cross-app browse resolves this app's
      // screenshot rather than the daemon's current foreground app (#5600).
      screenshotPath: node.screenshot_path
        ? buildNavigationNodeScreenshotUri(node.id, appId)
        : null,
      provenance: nodeProvenanceByNodeId.get(node.id) ?? [],
    }));

    // Aggregate edges by (from, to, toolName) to get unique transitions with counts.
    // Track every underlying edge id per group so provenance can be unioned across
    // the multiple edge rows that collapse into a single summary transition.
    const edgeAggregation = new Map<
      string,
      {
        id: number;
        from: string;
        to: string;
        toolName: string | null;
        count: number;
        edgeIds: number[];
      }
    >();

    for (const edge of dbEdges) {
      const key = `${edge.from_screen}|${edge.to_screen}|${edge.tool_name ?? ""}`;
      const existing = edgeAggregation.get(key);
      if (existing) {
        existing.count++;
        existing.edgeIds.push(edge.id);
      } else {
        edgeAggregation.set(key, {
          id: edge.id, // Use first edge's ID as representative
          from: edge.from_screen,
          to: edge.to_screen,
          toolName: edge.tool_name,
          count: 1,
          edgeIds: [edge.id],
        });
      }
    }

    const edges: NavigationGraphSummaryEdge[] = Array.from(edgeAggregation.values()).map((agg) => ({
      id: agg.id,
      from: agg.from,
      to: agg.to,
      toolName: agg.toolName,
      traversalCount: agg.count,
      provenance: mergeProvenanceRecords(
        agg.edgeIds.flatMap((edgeId) => edgeProvenanceByEdgeId.get(edgeId) ?? []),
      ),
    }));

    // Only include currentScreen if this is the currently active app
    const isCurrentApp = appId === this.currentAppId;

    return {
      appId,
      nodes,
      edges,
      currentScreen: isCurrentApp ? this.currentScreen : null,
    };
  }

  /**
   * Export a paginated navigation history for MCP resources.
   */
  public async exportGraphHistory(
    options: {
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<NavigationGraphHistoryPage> {
    if (!this.currentAppId) {
      return {
        appId: null,
        currentScreen: null,
        cursor: options.cursor ?? null,
        nextCursor: null,
        nodes: [],
        edges: [],
      };
    }

    const limit = this.normalizeHistoryLimit(options.limit);
    const cursor = options.cursor ? this.parseHistoryCursor(options.cursor) : null;

    const { edges: dbEdges, hasMore } = await this.repository.getEdgesPage(this.currentAppId, {
      cursor,
      limit,
    });

    const historyEdges: NavigationGraphHistoryEdge[] = dbEdges.map((edge) => ({
      id: edge.id,
      from: edge.from_screen,
      to: edge.to_screen,
      toolName: edge.tool_name,
      timestamp: edge.timestamp,
    }));

    const nodeNames =
      dbEdges.length > 0
        ? new Set([dbEdges[0].from_screen, ...dbEdges.map((edge) => edge.to_screen)])
        : new Set<string>();
    const dbNodes =
      nodeNames.size > 0
        ? await this.repository.getNodesByScreenNames(this.currentAppId, Array.from(nodeNames))
        : [];
    const nodeIdMap = new Map(dbNodes.map((node) => [node.screen_name, node.id] as const));

    const historyNodes: NavigationGraphHistoryNode[] = [];
    if (dbEdges.length > 0) {
      const firstEdge = dbEdges[0];
      historyNodes.push({
        id: nodeIdMap.get(firstEdge.from_screen) ?? null,
        screenName: firstEdge.from_screen,
        timestamp: firstEdge.timestamp,
        edgeId: null,
      });
      historyNodes.push(
        ...dbEdges.map((edge) => ({
          id: nodeIdMap.get(edge.to_screen) ?? null,
          screenName: edge.to_screen,
          timestamp: edge.timestamp,
          edgeId: edge.id,
        })),
      );
    } else if (this.currentScreen) {
      const node = await this.repository.getNode(this.currentAppId, this.currentScreen);
      if (node) {
        historyNodes.push({
          id: node.id,
          screenName: node.screen_name,
          timestamp: node.last_seen_at,
          edgeId: null,
        });
      }
    }

    const nextCursor = this.nextHistoryCursor(hasMore, dbEdges);

    return {
      appId: this.currentAppId,
      currentScreen: this.currentScreen,
      cursor: options.cursor ?? null,
      nextCursor,
      nodes: historyNodes,
      edges: historyEdges,
    };
  }

  /**
   * Get unpromoted navigation suggestions for the current app.
   * These are fingerprints that have been seen but not yet correlated to a named node.
   */
  public async getSuggestions(): Promise<NavigationSuggestionInfo[]> {
    if (!this.currentAppId) {
      return [];
    }

    const suggestions = await this.repository.getSuggestions(this.currentAppId);
    return suggestions.map((s) => ({
      id: s.id,
      fingerprintHash: s.fingerprint_hash,
      fingerprintData: s.fingerprint_data,
      firstSeenAt: s.first_seen_at,
      lastSeenAt: s.last_seen_at,
      occurrenceCount: s.occurrence_count,
    }));
  }

  private parseHistoryCursor(cursor: string): HistoryCursor {
    const [timestampRaw, idRaw] = cursor.split(":");
    const timestamp = Number(timestampRaw);
    const id = Number(idRaw);
    if (!Number.isFinite(timestamp) || !Number.isFinite(id)) {
      throw new Error(`Invalid history cursor: ${cursor}`);
    }
    return { timestamp, id };
  }

  private nextHistoryCursor(hasMore: boolean, edges: DBNavigationEdge[]): string | null {
    return hasMore && edges.length > 0 ? this.encodeHistoryCursor(edges[edges.length - 1]) : null;
  }

  private encodeHistoryCursor(edge: DBNavigationEdge): string {
    return `${edge.timestamp}:${edge.id}`;
  }

  private normalizeHistoryLimit(limit?: number): number {
    if (!limit || !Number.isFinite(limit)) {
      return this.HISTORY_PAGE_DEFAULT;
    }
    const normalized = Math.floor(limit);
    if (normalized <= 0) {
      return this.HISTORY_PAGE_DEFAULT;
    }
    return Math.min(normalized, this.HISTORY_PAGE_MAX);
  }
}
