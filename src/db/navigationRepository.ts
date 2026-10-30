import { type Kysely } from "kysely";
import { getDatabase } from "./database";
import type {
  Database,
  NewNavigationApp,
  NavigationApp,
  NewNavigationNode,
  NavigationNode,
  NewNavigationEdge,
  NavigationEdge,
  UIElement,
  NavigationNodeFingerprint,
  NewNavigationNodeFingerprint,
  NavigationSuggestion,
  NavigationBuildKey,
} from "./types";
import { logger } from "../utils/logger";
import { storedEdgeActionKey } from "./edgeReplayKey";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { nowIso } from "./nowIso";

import {
  getOrCreateUIElement,
  getUIElementsForEdge,
  linkUIElementsToEdge,
} from "./navigationUiElementQueries";
import {
  getEdgeModals,
  getNodeModals,
  getScrollPosition,
  setEdgeModals,
  setNodeModals,
  setScrollPosition,
  type ScrollPositionOptions,
} from "./navigationModalScrollQueries";
import {
  addOrUpdateSuggestion,
  getEdgeProvenanceForApp,
  getNodeProvenanceForApp,
  getOrCreateBuildKey,
  getSuggestions,
  hasNamedNodes,
  promoteSuggestion,
  recordEdgeObservation,
  recordNodeObservation,
  recordSuggestionObservation,
  transferSuggestionObservations,
} from "./navigationSuggestionQueries";
import type {
  NavigationEdgeProvenanceRow,
  NavigationEdgeTarget,
  NavigationEdgeTool,
  NavigationNodeProvenanceRow,
  NavigationQueryContext,
} from "./navigationRepositoryTypes";

export type {
  NavigationEdgeProvenanceRow,
  NavigationEdgeTarget,
  NavigationNodeProvenanceRow,
  NavigationEdgeTool,
} from "./navigationRepositoryTypes";

/**
 * Repository for navigation graph database operations.
 * Provides type-safe access to navigation data.
 */
export class NavigationRepository {
  private db: Kysely<Database> | null;
  private readonly ctx: NavigationQueryContext;

  constructor(
    db?: Kysely<Database>,
    private readonly timer: Timer = defaultTimer,
  ) {
    this.db = db ?? null;
    this.ctx = { timer: this.timer, repository: this, getDb: () => this.getDb() };
  }

  private getDb(): Kysely<Database> {
    if (this.db) {
      return this.db;
    }
    return getDatabase();
  }

  /**
   * The Kysely connection this repository resolves to: the executor bound via
   * `withExecutor`/the constructor, or the shared `getDatabase()` singleton when
   * unbound. Exposed so a caller enlisting a second repository in one transaction
   * can assert both resolve to the SAME connection before opening it — two unbound
   * repositories share the singleton, so identity (`===`) holds by construction.
   */
  resolveConnection(): Kysely<Database> {
    return this.getDb();
  }

  /**
   * Return a repository instance whose every read and write runs on the supplied
   * executor (a Kysely transaction handle) instead of the shared singleton
   * connection.
   *
   * This is the safe way to enlist navigation writes in a caller-owned
   * transaction: binding the whole instance means no method can accidentally fall
   * back to `getDatabase()` mid-transaction. A stray singleton query while a
   * transaction holds the single bun:sqlite connection deadlocks the daemon —
   * `#enterQuery` (bunSqliteDialect) spins forever for a non-owner and there is no
   * busy_timeout escape (the in-process JS mutex, not SQLite's lock).
   */
  withExecutor(executor: Kysely<Database>): NavigationRepository {
    return new NavigationRepository(executor, this.timer);
  }

  /**
   * Run `fn` inside a single transaction on this repository's connection, passing
   * the transaction executor to thread into `withExecutor`. Mirrors
   * `installedAppsRepository`'s in-repo transaction so callers never touch a raw
   * database handle. Keep the callback body to DB statements only — the
   * transaction takes exclusive ownership of the single connection, so any awaited
   * non-DB IO inside it stalls every other daemon writer for its duration.
   */
  async runInTransaction<T>(fn: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.getDb().transaction().execute(fn);
  }

  /**
   * Get or create a navigation app record.
   */
  async getOrCreateApp(appId: string): Promise<NavigationApp> {
    const db = this.getDb();

    // Atomic upsert on the app_id PRIMARY KEY. A concurrent first-create would
    // otherwise have one caller lose the SELECT/INSERT race and throw a UNIQUE
    // collision (R2356). The conflict path is a no-op touch (updated_at set to its
    // own value) so this stays a pure get-or-create that never mutates an existing
    // row — timestamp bumps remain the job of touchApp — while DO UPDATE still lets
    // RETURNING return the existing row.
    const now = nowIso(this.timer);
    const newApp: NewNavigationApp = {
      app_id: appId,
      updated_at: now,
    };

    const result = await db
      .insertInto("navigation_apps")
      .values(newApp)
      .onConflict((oc) =>
        oc.column("app_id").doUpdateSet((eb) => ({
          updated_at: eb.ref("navigation_apps.updated_at"),
        })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return result;
  }

  /**
   * Update app's updated_at timestamp.
   */
  async touchApp(appId: string): Promise<void> {
    const db = this.getDb();
    await db
      .updateTable("navigation_apps")
      .set({ updated_at: nowIso(this.timer) })
      .where("app_id", "=", appId)
      .execute();
  }

  /**
   * List every app that has a persisted navigation graph, newest-updated first.
   *
   * Device-independent: reads only persisted rows so the desktop can populate an
   * offline app picker. "Has a graph" means at least one recorded screen, so a
   * bare app row created by `getOrCreateApp`/`setCurrentApp` with no nodes is
   * excluded via a single EXISTS subquery over navigation_nodes (no row-by-row
   * probing). app_id is the PRIMARY KEY, so results are already distinct.
   */
  async listApps(): Promise<Array<Pick<NavigationApp, "app_id" | "updated_at">>> {
    const db = this.getDb();
    return db
      .selectFrom("navigation_apps")
      .select(["app_id", "updated_at"])
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("navigation_nodes")
            .select("navigation_nodes.id")
            .whereRef("navigation_nodes.app_id", "=", "navigation_apps.app_id"),
        ),
      )
      .orderBy("updated_at", "desc")
      .execute();
  }

  /**
   * Get or create a navigation node (screen).
   */
  async getOrCreateNode(
    appId: string,
    screenName: string,
    timestamp: number,
  ): Promise<NavigationNode> {
    const db = this.getDb();

    // Atomic upsert on UNIQUE(app_id, screen_name) (idx_navigation_nodes_app_screen).
    // visit_count increments in SQL so concurrent revisits don't lose increments and a
    // concurrent first-discovery doesn't throw a UNIQUE collision (R2356). first_seen_at
    // is left untouched on the conflict path. returningAll preserves the row return value.
    const newNode: NewNavigationNode = {
      app_id: appId,
      screen_name: screenName,
      first_seen_at: timestamp,
      last_seen_at: timestamp,
      visit_count: 1,
    };

    const result = await db
      .insertInto("navigation_nodes")
      .values(newNode)
      .onConflict((oc) =>
        oc.columns(["app_id", "screen_name"]).doUpdateSet((eb) => ({
          last_seen_at: timestamp,
          visit_count: eb("navigation_nodes.visit_count", "+", 1),
        })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return result;
  }

  /**
   * Get a node by app and screen name.
   */
  async getNode(appId: string, screenName: string): Promise<NavigationNode | undefined> {
    const db = this.getDb();
    return db
      .selectFrom("navigation_nodes")
      .selectAll()
      .where("app_id", "=", appId)
      .where("screen_name", "=", screenName)
      .executeTakeFirst();
  }

  /**
   * Get a node by app and node ID.
   */
  async getNodeById(appId: string, nodeId: number): Promise<NavigationNode | undefined> {
    const db = this.getDb();
    return db
      .selectFrom("navigation_nodes")
      .selectAll()
      .where("app_id", "=", appId)
      .where("id", "=", nodeId)
      .executeTakeFirst();
  }

  /**
   * Update back stack information for a node.
   * An absent task ID leaves the stored ID unchanged (Kysely omits undefined updates).
   */
  async updateNodeBackStack(
    appId: string,
    screenName: string,
    backStackDepth: number,
    taskId: number | undefined,
  ): Promise<void> {
    const db = this.getDb();
    await db
      .updateTable("navigation_nodes")
      .set({
        back_stack_depth: backStackDepth,
        task_id: taskId,
      })
      .where("app_id", "=", appId)
      .where("screen_name", "=", screenName)
      .execute();

    logger.debug(
      `[NAV_REPO] Updated back stack for ${screenName}: depth=${backStackDepth}, taskId=${taskId}`,
    );
  }

  /**
   * Get all nodes for an app.
   */
  async getNodes(appId: string): Promise<NavigationNode[]> {
    const db = this.getDb();
    return db
      .selectFrom("navigation_nodes")
      .selectAll()
      .where("app_id", "=", appId)
      .orderBy("screen_name", "asc")
      .execute();
  }

  /**
   * Get nodes by screen name.
   */
  async getNodesByScreenNames(appId: string, screenNames: string[]): Promise<NavigationNode[]> {
    if (screenNames.length === 0) {
      return [];
    }

    const db = this.getDb();
    return db
      .selectFrom("navigation_nodes")
      .selectAll()
      .where("app_id", "=", appId)
      .where("screen_name", "in", screenNames)
      .execute();
  }

  /**
   * Create a navigation edge.
   */
  async createEdge(
    appId: string,
    fromScreen: string,
    toScreen: string,
    tool: NavigationEdgeTool,
    timestamp: number,
  ): Promise<NavigationEdge> {
    const { toolName, toolArgs } = tool;
    const db = this.getDb();

    const newEdge: NewNavigationEdge = {
      app_id: appId,
      from_screen: fromScreen,
      to_screen: toScreen,
      tool_name: toolName,
      tool_args: toolArgs ? JSON.stringify(toolArgs) : null,
      timestamp,
    };

    const result = await db
      .insertInto("navigation_edges")
      .values(newEdge)
      .returningAll()
      .executeTakeFirstOrThrow();

    const toolInfo = toolName ? ` via ${toolName}` : " (unknown)";
    logger.debug(
      `[NAV_REPO] Edge created: ${fromScreen} → ${toScreen}${toolInfo} (id=${result.id})`,
    );

    return result;
  }

  /**
   * Get every edge ROW for an app: one per recorded traversal (the append-only
   * traversal log). Use this when the number of traversals matters (e.g. the graph
   * summary's traversalCount); readers that treat edges as transitions want
   * {@link getDistinctEdges}.
   */
  async getEdges(appId: string): Promise<NavigationEdge[]> {
    const db = this.getDb();
    return db
      .selectFrom("navigation_edges")
      .selectAll()
      .where("app_id", "=", appId)
      .orderBy("timestamp", "asc")
      .execute();
  }

  /**
   * Distinct transitions of an app: the newest traversal row (highest id, which is
   * insertion order and so immune to a device clock stepping backwards, #10031) of
   * each screen-pair/action group. SQL first collapses identical stored arguments;
   * the canonical replay key then collapses legacy rows carrying device routing.
   * Hydration still reads O(distinct transitions), not all traversals (#10194).
   */
  async getDistinctEdges(appId: string): Promise<NavigationEdge[]> {
    return this.collapseReplayEquivalentEdges(
      await this.selectNewestEdgePerTransition(appId).execute(),
    );
  }

  private collapseReplayEquivalentEdges<
    T extends Pick<NavigationEdge, "id" | "from_screen" | "to_screen" | "tool_name" | "tool_args">,
  >(rows: T[]): T[] {
    const newest = new Map<string, T>();
    for (const row of rows) {
      const key = JSON.stringify([
        row.from_screen,
        row.to_screen,
        storedEdgeActionKey(row.tool_name, row.tool_args),
      ]);
      const previous = newest.get(key);
      if (!previous || row.id > previous.id) {
        newest.set(key, row);
      }
    }
    const ids = new Set([...newest.values()].map((row) => row.id));
    return rows.filter((row) => ids.has(row.id));
  }

  /**
   * Query for the newest `navigation_edges` row of each distinct transition of an
   * app, optionally restricted to one endpoint screen (served by the from/to index).
   * A transition is identified by its screen pair plus the recorded tool call, the
   * raw identity used before canonical replay-key collapse; GROUP BY treats NULL
   * `tool_name` / `tool_args` (an unattributed edge) as one group.
   */
  private selectNewestEdgePerTransition(
    appId: string,
    endpoint: { column: "from_screen" | "to_screen"; screen: string } | null = null,
  ) {
    const db = this.getDb();
    let newestIds = db
      .selectFrom("navigation_edges")
      .select((eb) => eb.fn.max<number>("id").as("id"))
      .where("app_id", "=", appId);
    let rows = db.selectFrom("navigation_edges").selectAll().where("app_id", "=", appId);
    if (endpoint) {
      newestIds = newestIds.where(endpoint.column, "=", endpoint.screen);
      rows = rows.where(endpoint.column, "=", endpoint.screen);
    }
    return rows
      .where("id", "in", newestIds.groupBy(["from_screen", "to_screen", "tool_name", "tool_args"]))
      .orderBy("timestamp", "asc")
      .orderBy("id", "asc");
  }

  /**
   * Get edges for an app with pagination support.
   */
  async getEdgesPage(
    appId: string,
    options: {
      cursor?: { timestamp: number; id: number } | null;
      limit: number;
    },
  ): Promise<{ edges: NavigationEdge[]; hasMore: boolean }> {
    const db = this.getDb();
    let query = db.selectFrom("navigation_edges").selectAll().where("app_id", "=", appId);

    if (options.cursor) {
      query = query.where(({ eb, or, and }) =>
        or([
          eb("timestamp", ">", options.cursor!.timestamp),
          and([eb("timestamp", "=", options.cursor!.timestamp), eb("id", ">", options.cursor!.id)]),
        ]),
      );
    }

    const rows = await query
      .orderBy("timestamp", "asc")
      .orderBy("id", "asc")
      .limit(options.limit + 1)
      .execute();

    const hasMore = rows.length > options.limit;
    const edges = hasMore ? rows.slice(0, options.limit) : rows;

    return { edges, hasMore };
  }

  /**
   * Get the distinct transitions leaving a specific screen (newest traversal row of
   * each, see {@link getDistinctEdges}).
   */
  async getEdgesFrom(appId: string, fromScreen: string): Promise<NavigationEdge[]> {
    return this.collapseReplayEquivalentEdges(
      await this.selectNewestEdgePerTransition(appId, {
        column: "from_screen",
        screen: fromScreen,
      }).execute(),
    );
  }

  /**
   * Adjacency-only read for graph walks: the distinct (to_screen, tool_name, tool_args)
   * combinations leaving `fromScreen`, app-scoped like getEdgesFrom. Edge modals, UI
   * elements, scroll positions and provenance are not read, `tool_args` stays the raw
   * stored string (malformed payloads retain their raw identity), and
   * duplicate rows for the same transition collapse to one. Uses the existing
   * idx_navigation_edges_from index; no schema change.
   */
  async getEdgeTargetsFrom(appId: string, fromScreen: string): Promise<NavigationEdgeTarget[]> {
    const db = this.getDb();
    const rows = await db
      .selectFrom("navigation_edges")
      .select(["to_screen", "tool_name", "tool_args"])
      .distinct()
      .where("app_id", "=", appId)
      .where("from_screen", "=", fromScreen)
      .execute();
    const transitions = new Map<string, NavigationEdgeTarget>();
    for (const row of rows) {
      const key = JSON.stringify([
        row.to_screen,
        storedEdgeActionKey(row.tool_name, row.tool_args),
      ]);
      transitions.set(key, {
        toScreen: row.to_screen,
        toolName: row.tool_name,
        toolArgs: row.tool_args,
      });
    }
    return [...transitions.values()];
  }

  /**
   * Get the distinct transitions entering a specific screen (newest traversal row of
   * each, see {@link getDistinctEdges}).
   */
  async getEdgesTo(appId: string, toScreen: string): Promise<NavigationEdge[]> {
    return this.collapseReplayEquivalentEdges(
      await this.selectNewestEdgePerTransition(appId, {
        column: "to_screen",
        screen: toScreen,
      }).execute(),
    );
  }

  /**
   * Get or create a UI element.
   */
  async getOrCreateUIElement(
    appId: string,
    element: {
      text?: string;
      resourceId?: string;
      contentDescription?: string;
      className?: string;
      bounds?: { left: number; top: number; right: number; bottom: number };
      clickable?: boolean;
      scrollable?: boolean;
    },
    timestamp: number,
  ): Promise<UIElement> {
    return getOrCreateUIElement(this.ctx, appId, element, timestamp);
  }

  /**
   * Link UI elements to an edge.
   *
   * Idempotent under UNIQUE(edge_id, ui_element_id) (idx_edge_ui_elements_pk, #6463):
   * two `SelectedElement`s in the same interaction can resolve to the same
   * `ui_elements` row (matched on text/resourceId/contentDescription with no bounds),
   * and re-observing the same edge later re-links element ids already linked from a
   * prior call. Neither case may throw `SQLITE_CONSTRAINT_UNIQUE` — that would abort
   * the enclosing `recordNavigationEvent` transaction and silently drop the whole
   * navigation-graph write, not just the offending link.
   */
  async linkUIElementsToEdge(edgeId: number, uiElementIds: number[]): Promise<void> {
    return linkUIElementsToEdge(this.ctx, edgeId, uiElementIds);
  }

  /**
   * Get UI elements for an edge.
   */
  async getUIElementsForEdge(edgeId: number): Promise<UIElement[]> {
    return getUIElementsForEdge(this.ctx, edgeId);
  }

  /**
   * Set modal stack for a node.
   *
   * Wraps the delete+insert pair in a transaction (issue #6656): without it, a
   * concurrent caller replacing the same node's modal stack can interleave
   * DELETE/DELETE/INSERT/INSERT, transiently exposing an empty stack to a reader
   * and racing the second INSERT into a UNIQUE(node_id, stack_level) collision.
   * Mirrors the db.isTransaction guard in getOrCreateUIElement/linkUIElementsToEdge
   * so a repo already bound to a caller's transaction runs the body directly
   * instead of attempting a nested BEGIN.
   */
  async setNodeModals(nodeId: number, modalStack: string[]): Promise<void> {
    return setNodeModals(this.ctx, nodeId, modalStack);
  }

  /**
   * Get modal stack for a node.
   */
  async getNodeModals(nodeId: number): Promise<string[]> {
    return getNodeModals(this.ctx, nodeId);
  }

  /**
   * Set modal stack for an edge (from or to position).
   *
   * Wraps the delete+insert pair in a transaction (issue #6656), symmetric to
   * setNodeModals: without it, a concurrent caller replacing the same
   * (edge_id, position) modal stack can interleave DELETE/DELETE/INSERT/INSERT,
   * transiently exposing an empty stack to a reader and racing the second INSERT
   * into a UNIQUE(edge_id, position, stack_level) collision. The db.isTransaction
   * guard mirrors getOrCreateUIElement/linkUIElementsToEdge so a repo already
   * bound to a caller's transaction runs the body directly instead of attempting
   * a nested BEGIN.
   */
  async setEdgeModals(
    edgeId: number,
    position: "from" | "to",
    modalStack: string[],
  ): Promise<void> {
    return setEdgeModals(this.ctx, edgeId, position, modalStack);
  }

  /**
   * Get modal stack for an edge position.
   */
  async getEdgeModals(edgeId: number, position: "from" | "to"): Promise<string[]> {
    return getEdgeModals(this.ctx, edgeId, position);
  }

  /**
   * Set scroll position for an edge.
   *
   * Wraps the delete+insert pair in a transaction (issue #6656): without it, a
   * concurrent caller replacing the same edge's scroll position can interleave
   * DELETE/DELETE/INSERT/INSERT, transiently exposing a missing scroll position
   * to a reader and racing the second INSERT into the scroll_positions.edge_id
   * PRIMARY KEY collision. The db.isTransaction guard mirrors
   * getOrCreateUIElement/linkUIElementsToEdge so a repo already bound to a
   * caller's transaction runs the body directly instead of attempting a nested
   * BEGIN.
   */
  async setScrollPosition(
    edgeId: number,
    targetElementId: number,
    direction: string,
    options: ScrollPositionOptions = {},
  ): Promise<void> {
    return setScrollPosition(this.ctx, edgeId, targetElementId, direction, options);
  }

  /**
   * Get scroll position for an edge.
   */
  async getScrollPosition(edgeId: number): Promise<{
    targetElement: UIElement;
    containerElement?: UIElement;
    direction: string;
    speed?: string;
    swipeCount?: number;
  } | null> {
    return getScrollPosition(this.ctx, edgeId);
  }

  /**
   * Get navigation graph statistics for an app.
   */
  async getStats(appId: string): Promise<{
    nodeCount: number;
    edgeCount: number;
    toolEdgeCount: number;
    unknownEdgeCount: number;
  }> {
    const db = this.getDb();

    const nodes = await db
      .selectFrom("navigation_nodes")
      .select(db.fn.countAll<number>().as("count"))
      .where("app_id", "=", appId)
      .executeTakeFirst();

    // Count distinct transitions, not traversal rows (#10194); see getDistinctEdges.
    // Payloads such as ui_state are unnecessary for replay identity or counts.
    const transitions = this.collapseReplayEquivalentEdges(
      await this.selectNewestEdgePerTransition(appId)
        .clearSelect()
        .select(["id", "from_screen", "to_screen", "tool_name", "tool_args"])
        .execute(),
    );
    const edgeCount = transitions.length;
    const toolEdgeCount = transitions.filter((edge) => edge.tool_name !== null).length;

    return {
      nodeCount: Number(nodes?.count || 0),
      edgeCount,
      toolEdgeCount,
      unknownEdgeCount: edgeCount - toolEdgeCount,
    };
  }

  /**
   * Clear all navigation data for an app.
   */
  async clearApp(appId: string): Promise<void> {
    const db = this.getDb();

    // Cascade deletes will handle related tables
    await db.deleteFrom("navigation_apps").where("app_id", "=", appId).execute();

    logger.info(`[NAV_REPO] Cleared navigation data for app: ${appId}`);
  }

  /**
   * Update the screenshot path for a navigation node.
   */
  async updateNodeScreenshot(
    appId: string,
    screenName: string,
    screenshotPath: string | null,
  ): Promise<void> {
    const db = this.getDb();
    await db
      .updateTable("navigation_nodes")
      .set({ screenshot_path: screenshotPath })
      .where("app_id", "=", appId)
      .where("screen_name", "=", screenName)
      .execute();

    logger.debug(`[NAV_REPO] Updated screenshot for ${screenName}: ${screenshotPath}`);
  }

  /**
   * Update the screenshot path for a navigation node by node ID.
   */
  async updateNodeScreenshotById(nodeId: number, screenshotPath: string | null): Promise<void> {
    const db = this.getDb();
    await db
      .updateTable("navigation_nodes")
      .set({ screenshot_path: screenshotPath })
      .where("id", "=", nodeId)
      .execute();

    logger.debug(`[NAV_REPO] Updated screenshot for node ${nodeId}: ${screenshotPath}`);
  }

  /**
   * Clear only nodes and edges for an app, keeping the app record.
   * Useful for tests that want to reset graph state without losing the app.
   */
  async clearAppGraph(appId: string): Promise<void> {
    const db = this.getDb();

    // Delete edges first (they reference nodes via screen names, not FK, so no cascade)
    await db.deleteFrom("navigation_edges").where("app_id", "=", appId).execute();

    // Delete nodes (cascade will delete node_modals and navigation_node_fingerprints)
    await db.deleteFrom("navigation_nodes").where("app_id", "=", appId).execute();

    // Delete any orphaned UI elements for this app
    await db.deleteFrom("ui_elements").where("app_id", "=", appId).execute();

    // Delete navigation suggestions for this app
    await db.deleteFrom("navigation_suggestions").where("app_id", "=", appId).execute();

    logger.info(`[NAV_REPO] Cleared graph data for app: ${appId}`);
  }

  // ==========================================
  // Fingerprint and Suggestion Methods
  // ==========================================

  /**
   * Get or create a fingerprint record for a node.
   * Fingerprints are scoped per app to prevent cross-app collisions.
   */
  async getOrCreateFingerprint(
    appId: string,
    nodeId: number,
    hash: string,
    data: string,
    timestamp: number,
  ): Promise<NavigationNodeFingerprint> {
    const db = this.getDb();

    // Atomic upsert on UNIQUE(app_id, fingerprint_hash)
    // (idx_navigation_node_fingerprints_app_hash). occurrence_count increments in SQL so
    // a concurrent first-create no longer throws a UNIQUE collision (dropping the write)
    // and concurrent revisits don't lose increments (R2356). node_id/first_seen_at are
    // left untouched on the conflict path — the first writer's node association wins.
    const newFingerprint: NewNavigationNodeFingerprint = {
      app_id: appId,
      node_id: nodeId,
      fingerprint_hash: hash,
      fingerprint_data: data,
      first_seen_at: timestamp,
      last_seen_at: timestamp,
      occurrence_count: 1,
    };

    const result = await db
      .insertInto("navigation_node_fingerprints")
      .values(newFingerprint)
      .onConflict((oc) =>
        oc.columns(["app_id", "fingerprint_hash"]).doUpdateSet((eb) => ({
          last_seen_at: timestamp,
          occurrence_count: eb("navigation_node_fingerprints.occurrence_count", "+", 1),
        })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return result;
  }

  /**
   * Find a navigation node by fingerprint hash within a specific app.
   * Fingerprints are scoped per app to prevent cross-app collisions.
   */
  async getNodeByFingerprint(appId: string, hash: string): Promise<NavigationNode | undefined> {
    const db = this.getDb();

    const fingerprint = await db
      .selectFrom("navigation_node_fingerprints")
      .select("node_id")
      .where("app_id", "=", appId)
      .where("fingerprint_hash", "=", hash)
      .executeTakeFirst();

    if (!fingerprint) {
      return undefined;
    }

    return db
      .selectFrom("navigation_nodes")
      .selectAll()
      .where("id", "=", fingerprint.node_id)
      .where("app_id", "=", appId)
      .executeTakeFirst();
  }

  /**
   * Get all fingerprints associated with a node.
   */
  async getFingerprintsForNode(nodeId: number): Promise<NavigationNodeFingerprint[]> {
    const db = this.getDb();
    return db
      .selectFrom("navigation_node_fingerprints")
      .selectAll()
      .where("node_id", "=", nodeId)
      .execute();
  }

  /**
   * Add or update a navigation suggestion (uncorrelated fingerprint).
   */
  async addOrUpdateSuggestion(
    appId: string,
    hash: string,
    data: string,
    timestamp: number,
  ): Promise<NavigationSuggestion> {
    return addOrUpdateSuggestion(this.ctx, appId, hash, data, timestamp);
  }

  /** Record one uncorrelated reach under its actual build/device/session. */
  async recordSuggestionObservation(
    suggestionId: number,
    buildKeyId: number,
    deviceId: string,
    sessionUuid: string,
    seenAt: number,
  ): Promise<void> {
    return recordSuggestionObservation(
      this.ctx,
      suggestionId,
      { buildKeyId, deviceId, sessionUuid },
      seenAt,
    );
  }

  /** Move every historical reach to its named node, preserving observation windows.
   * The caller's promotion transaction makes transfer and cleanup atomic.
   * Returns false for pre-migration suggestions with no known provenance. */
  async transferSuggestionObservations(suggestionId: number, nodeId: number): Promise<boolean> {
    return transferSuggestionObservations(this.ctx, suggestionId, nodeId);
  }

  /**
   * Promote a suggestion to a named node.
   * Creates a fingerprint record for the node and links the suggestion.
   */
  async promoteSuggestion(
    suggestionId: number,
    nodeId: number,
    timestamp: number,
  ): Promise<NavigationNodeFingerprint> {
    return promoteSuggestion(this.ctx, suggestionId, nodeId, timestamp);
  }

  /**
   * Check if an app has any named navigation nodes.
   */
  async hasNamedNodes(appId: string): Promise<boolean> {
    return hasNamedNodes(this.ctx, appId);
  }

  /**
   * Get unpromoted suggestions for an app.
   */
  async getSuggestions(appId: string): Promise<NavigationSuggestion[]> {
    return getSuggestions(this.ctx, appId);
  }

  // ==========================================
  // Build-key + provenance observation methods (#4984)
  // ==========================================

  /**
   * Get or create the build-key row for (app_id, version_code, content_hash).
   *
   * Atomic upsert on UNIQUE(app_id, version_code, content_hash)
   * (idx_navigation_build_keys_unique) so a concurrent first-create doesn't throw
   * a UNIQUE collision. The conflict path is a no-op touch (app_id set to its own
   * value) so RETURNING still yields the existing row without mutating it.
   */
  async getOrCreateBuildKey(
    appId: string,
    versionCode: number,
    contentHash: string,
  ): Promise<NavigationBuildKey> {
    return getOrCreateBuildKey(this.ctx, appId, versionCode, contentHash);
  }

  /**
   * Record a per-node provenance observation.
   *
   * Atomic upsert on UNIQUE(node_id, build_key_id, device_id, session_uuid): a
   * revisit within the same (build, device, session) widens the seen window in SQL.
   * Android WS handlers are not serialized, so an out-of-order commit could make
   * first_seen_at > last_seen_at — hence MIN/MAX rather than an unconditional set,
   * keeping the bounds monotonic regardless of arrival order.
   */
  async recordNodeObservation(
    nodeId: number,
    buildKeyId: number,
    deviceId: string,
    sessionUuid: string,
    seenAt: number,
  ): Promise<void> {
    return recordNodeObservation(this.ctx, nodeId, { buildKeyId, deviceId, sessionUuid }, seenAt);
  }

  /**
   * Record a per-edge provenance observation (symmetric to recordNodeObservation),
   * with the same MIN/MAX monotonic-window handling for out-of-order commits.
   */
  async recordEdgeObservation(
    edgeId: number,
    buildKeyId: number,
    deviceId: string,
    sessionUuid: string,
    seenAt: number,
  ): Promise<void> {
    return recordEdgeObservation(this.ctx, edgeId, { buildKeyId, deviceId, sessionUuid }, seenAt);
  }

  /**
   * Read every node-provenance observation for an app in one typed join
   * (nav (app,build) Phase 2, #4985): node_observations ⋈ build_keys, scoped by
   * the node's own `app_id`. Rows are ordered `last_seen_at` desc so the caller's
   * per-node grouping preserves recency order deterministically. `package_id` is
   * the build key's `app_id` (== the queried app), surfaced for the read shape.
   */
  async getNodeProvenanceForApp(appId: string): Promise<NavigationNodeProvenanceRow[]> {
    return getNodeProvenanceForApp(this.ctx, appId);
  }

  /**
   * Read every edge-provenance observation for an app in one typed join
   * (nav (app,build) Phase 2, #4985), symmetric to
   * {@link getNodeProvenanceForApp}. Keyed by `edge_id` so the caller can union
   * provenance across the multiple edge rows that aggregate into one summary
   * transition.
   */
  async getEdgeProvenanceForApp(appId: string): Promise<NavigationEdgeProvenanceRow[]> {
    return getEdgeProvenanceForApp(this.ctx, appId);
  }

  /**
   * Update a node's visit count and last_seen_at without creating a new node.
   */
  async updateNodeVisit(nodeId: number, timestamp: number): Promise<void> {
    const db = this.getDb();
    await db
      .updateTable("navigation_nodes")
      .set((eb) => ({
        last_seen_at: timestamp,
        visit_count: eb("visit_count", "+", 1),
      }))
      .where("id", "=", nodeId)
      .execute();
  }
}
