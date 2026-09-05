import { sql, type Kysely } from "kysely";
import { getDatabase } from "./database";
import type {
  Database,
  NewNavigationApp,
  NavigationApp,
  NewNavigationNode,
  NavigationNode,
  NewNavigationEdge,
  NavigationEdge,
  NewUIElement,
  UIElement,
  NewEdgeUIElement,
  NewNodeModal,
  NewEdgeModal,
  NewScrollPosition,
  NavigationNodeFingerprint,
  NewNavigationNodeFingerprint,
  NavigationSuggestion,
  NewNavigationSuggestion,
  NavigationBuildKey,
  NewNavigationBuildKey,
  NewNavigationNodeObservation,
  NewNavigationEdgeObservation,
} from "./types";
import { logger } from "../utils/logger";

/**
 * Flat row of a node-provenance join (nav (app,build) Phase 2, #4985):
 * navigation_node_observations ⋈ navigation_build_keys. `package_id` is the build
 * key's `app_id`. Grouped per `node_id` by the caller.
 */
export interface NavigationNodeProvenanceRow {
  node_id: number;
  package_id: string;
  version_code: number;
  content_hash: string;
  device_id: string;
  session_uuid: string;
  last_seen_at: number;
}

/**
 * Flat row of an edge-provenance join (#4985), symmetric to
 * {@link NavigationNodeProvenanceRow} but keyed by `edge_id`.
 */
export interface NavigationEdgeProvenanceRow {
  edge_id: number;
  package_id: string;
  version_code: number;
  content_hash: string;
  device_id: string;
  session_uuid: string;
  last_seen_at: number;
}

/**
 * Repository for navigation graph database operations.
 * Provides type-safe access to navigation data.
 */
export class NavigationRepository {
  private db: Kysely<Database> | null;

  constructor(db?: Kysely<Database>) {
    this.db = db ?? null;
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
    return new NavigationRepository(executor);
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
    const now = new Date().toISOString();
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
      .set({ updated_at: new Date().toISOString() })
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
   */
  async updateNodeBackStack(
    appId: string,
    screenName: string,
    backStackDepth: number,
    taskId: number,
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
    toolName: string | null,
    toolArgs: Record<string, any> | null,
    timestamp: number,
  ): Promise<NavigationEdge> {
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
   * Get all edges for an app.
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
   * Get edges from a specific screen.
   */
  async getEdgesFrom(appId: string, fromScreen: string): Promise<NavigationEdge[]> {
    const db = this.getDb();
    return db
      .selectFrom("navigation_edges")
      .selectAll()
      .where("app_id", "=", appId)
      .where("from_screen", "=", fromScreen)
      .execute();
  }

  /**
   * Get edges to a specific screen.
   */
  async getEdgesTo(appId: string, toScreen: string): Promise<NavigationEdge[]> {
    const db = this.getDb();
    return db
      .selectFrom("navigation_edges")
      .selectAll()
      .where("app_id", "=", appId)
      .where("to_screen", "=", toScreen)
      .execute();
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
    const db = this.getDb();

    // ui_elements has no UNIQUE index and matching is on a *dynamic* subset of columns,
    // so this get-or-create cannot be expressed as a single onConflict upsert. Wrap the
    // SELECT-then-INSERT/UPDATE in a transaction instead: BEGIN takes exclusive ownership
    // of the single connection (bunSqliteDialect #reserveTransaction), so concurrent
    // callers for the same element serialize rather than both inserting duplicate rows
    // (R2356). Keep the body to DB reads/writes only — no IO — since it blocks the daemon
    // for its duration.
    //
    // When this repo is already bound to a caller's transaction (via withExecutor),
    // opening another transaction would be a nested BEGIN on the same connection —
    // `#reserveTransaction` throws "Nested transactions are not supported". Run the
    // body directly on the existing executor instead; it is already serialized and
    // atomic under the enclosing transaction.
    if (db.isTransaction) {
      return this.getOrCreateUIElementWithin(db, appId, element, timestamp);
    }
    return db
      .transaction()
      .execute((trx) => this.getOrCreateUIElementWithin(trx, appId, element, timestamp));
  }

  private async getOrCreateUIElementWithin(
    trx: Kysely<Database>,
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
    // Try to find existing element with same properties
    let query = trx.selectFrom("ui_elements").selectAll().where("app_id", "=", appId);

    if (element.text !== undefined) {
      query = query.where("text", "=", element.text);
    }
    if (element.resourceId !== undefined) {
      query = query.where("resource_id", "=", element.resourceId);
    }
    if (element.contentDescription !== undefined) {
      query = query.where("content_description", "=", element.contentDescription);
    }
    if (element.className !== undefined) {
      query = query.where("class_name", "=", element.className);
    }
    if (element.bounds) {
      query = query
        .where("bounds_left", "=", element.bounds.left)
        .where("bounds_top", "=", element.bounds.top)
        .where("bounds_right", "=", element.bounds.right)
        .where("bounds_bottom", "=", element.bounds.bottom);
    }

    const existing = await query.executeTakeFirst();

    if (existing) {
      // Update last_seen_at
      await trx
        .updateTable("ui_elements")
        .set({ last_seen_at: timestamp })
        .where("id", "=", existing.id)
        .execute();

      return {
        ...existing,
        last_seen_at: timestamp,
      };
    }

    // Create new UI element
    const newElement: NewUIElement = {
      app_id: appId,
      text: element.text ?? null,
      resource_id: element.resourceId ?? null,
      content_description: element.contentDescription ?? null,
      class_name: element.className ?? null,
      bounds_left: element.bounds?.left ?? null,
      bounds_top: element.bounds?.top ?? null,
      bounds_right: element.bounds?.right ?? null,
      bounds_bottom: element.bounds?.bottom ?? null,
      clickable: element.clickable !== undefined ? (element.clickable ? 1 : 0) : null,
      scrollable: element.scrollable !== undefined ? (element.scrollable ? 1 : 0) : null,
      first_seen_at: timestamp,
      last_seen_at: timestamp,
    };

    const result = await trx
      .insertInto("ui_elements")
      .values(newElement)
      .returningAll()
      .executeTakeFirstOrThrow();

    return result;
  }

  /**
   * Link UI elements to an edge.
   */
  async linkUIElementsToEdge(edgeId: number, uiElementIds: number[]): Promise<void> {
    if (uiElementIds.length === 0) {
      return;
    }

    const db = this.getDb();
    const values: NewEdgeUIElement[] = uiElementIds.map((uiElementId, index) => ({
      edge_id: edgeId,
      ui_element_id: uiElementId,
      selection_order: index,
    }));

    await db.insertInto("edge_ui_elements").values(values).execute();
  }

  /**
   * Get UI elements for an edge.
   */
  async getUIElementsForEdge(edgeId: number): Promise<UIElement[]> {
    const db = this.getDb();
    return db
      .selectFrom("edge_ui_elements")
      .innerJoin("ui_elements", "ui_elements.id", "edge_ui_elements.ui_element_id")
      .selectAll("ui_elements")
      .where("edge_id", "=", edgeId)
      .orderBy("selection_order", "asc")
      .execute();
  }

  /**
   * Set modal stack for a node.
   */
  async setNodeModals(nodeId: number, modalStack: string[]): Promise<void> {
    const db = this.getDb();

    // Delete existing modals
    await db.deleteFrom("node_modals").where("node_id", "=", nodeId).execute();

    if (modalStack.length === 0) {
      return;
    }

    // Insert new modals
    const values: NewNodeModal[] = modalStack.map((modalId, index) => ({
      node_id: nodeId,
      modal_identifier: modalId,
      stack_level: index,
    }));

    await db.insertInto("node_modals").values(values).execute();
  }

  /**
   * Get modal stack for a node.
   */
  async getNodeModals(nodeId: number): Promise<string[]> {
    const db = this.getDb();
    const modals = await db
      .selectFrom("node_modals")
      .select("modal_identifier")
      .where("node_id", "=", nodeId)
      .orderBy("stack_level", "asc")
      .execute();

    return modals.map((m) => m.modal_identifier);
  }

  /**
   * Set modal stack for an edge (from or to position).
   */
  async setEdgeModals(
    edgeId: number,
    position: "from" | "to",
    modalStack: string[],
  ): Promise<void> {
    const db = this.getDb();

    // Delete existing modals for this position
    await db
      .deleteFrom("edge_modals")
      .where("edge_id", "=", edgeId)
      .where("position", "=", position)
      .execute();

    if (modalStack.length === 0) {
      return;
    }

    // Insert new modals
    const values: NewEdgeModal[] = modalStack.map((modalId, index) => ({
      edge_id: edgeId,
      position,
      modal_identifier: modalId,
      stack_level: index,
    }));

    await db.insertInto("edge_modals").values(values).execute();
  }

  /**
   * Get modal stack for an edge position.
   */
  async getEdgeModals(edgeId: number, position: "from" | "to"): Promise<string[]> {
    const db = this.getDb();
    const modals = await db
      .selectFrom("edge_modals")
      .select("modal_identifier")
      .where("edge_id", "=", edgeId)
      .where("position", "=", position)
      .orderBy("stack_level", "asc")
      .execute();

    return modals.map((m) => m.modal_identifier);
  }

  /**
   * Set scroll position for an edge.
   */
  async setScrollPosition(
    edgeId: number,
    targetElementId: number,
    direction: string,
    containerElementId?: number,
    speed?: string,
    swipeCount?: number,
  ): Promise<void> {
    const db = this.getDb();

    const scrollPos: NewScrollPosition = {
      edge_id: edgeId,
      target_element_id: targetElementId,
      container_element_id: containerElementId ?? null,
      direction,
      speed: speed ?? null,
      swipe_count: swipeCount ?? null,
    };

    // Upsert: delete if exists, then insert
    await db.deleteFrom("scroll_positions").where("edge_id", "=", edgeId).execute();

    await db.insertInto("scroll_positions").values(scrollPos).execute();
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
    const db = this.getDb();

    const result = await db
      .selectFrom("scroll_positions")
      .innerJoin("ui_elements as target", "target.id", "scroll_positions.target_element_id")
      .leftJoin("ui_elements as container", "container.id", "scroll_positions.container_element_id")
      .select([
        "scroll_positions.direction",
        "scroll_positions.speed",
        "scroll_positions.swipe_count",
      ])
      .selectAll("target")
      .select([
        "container.id as container_id",
        "container.text as container_text",
        "container.resource_id as container_resource_id",
        "container.content_description as container_content_description",
      ])
      .where("edge_id", "=", edgeId)
      .executeTakeFirst();

    if (!result) {
      return null;
    }

    const response: {
      targetElement: UIElement;
      containerElement?: UIElement;
      direction: string;
      speed?: string;
      swipeCount?: number;
    } = {
      targetElement: {
        id: result.id,
        app_id: result.app_id,
        text: result.text,
        resource_id: result.resource_id,
        content_description: result.content_description,
        class_name: result.class_name,
        bounds_left: result.bounds_left,
        bounds_top: result.bounds_top,
        bounds_right: result.bounds_right,
        bounds_bottom: result.bounds_bottom,
        clickable: result.clickable,
        scrollable: result.scrollable,
        first_seen_at: result.first_seen_at,
        last_seen_at: result.last_seen_at,
        created_at: result.created_at,
      },
      direction: result.direction,
      speed: result.speed ?? undefined,
      swipeCount: result.swipe_count ?? undefined,
    };

    // Add container element if present
    if (result.container_id) {
      response.containerElement = {
        id: result.container_id,
        app_id: result.app_id, // Same app
        text: result.container_text,
        resource_id: result.container_resource_id,
        content_description: result.container_content_description,
        class_name: null,
        bounds_left: null,
        bounds_top: null,
        bounds_right: null,
        bounds_bottom: null,
        clickable: null,
        scrollable: null,
        first_seen_at: 0,
        last_seen_at: 0,
        created_at: "",
      };
    }

    return response;
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

    const edges = await db
      .selectFrom("navigation_edges")
      .select(db.fn.countAll<number>().as("count"))
      .where("app_id", "=", appId)
      .executeTakeFirst();

    const toolEdges = await db
      .selectFrom("navigation_edges")
      .select(db.fn.countAll<number>().as("count"))
      .where("app_id", "=", appId)
      .where("tool_name", "is not", null)
      .executeTakeFirst();

    const unknownEdges = await db
      .selectFrom("navigation_edges")
      .select(db.fn.countAll<number>().as("count"))
      .where("app_id", "=", appId)
      .where("tool_name", "is", null)
      .executeTakeFirst();

    return {
      nodeCount: Number(nodes?.count || 0),
      edgeCount: Number(edges?.count || 0),
      toolEdgeCount: Number(toolEdges?.count || 0),
      unknownEdgeCount: Number(unknownEdges?.count || 0),
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
    const db = this.getDb();

    // Atomic upsert on UNIQUE(app_id, fingerprint_hash)
    // (idx_navigation_suggestions_app_hash). occurrence_count increments in SQL so a
    // concurrent first-create no longer throws a UNIQUE collision and concurrent
    // revisits don't lose increments (R2356). first_seen_at and promoted_to_fingerprint_id
    // are left untouched on the conflict path so a prior promotion is never clobbered.
    const newSuggestion: NewNavigationSuggestion = {
      app_id: appId,
      fingerprint_hash: hash,
      fingerprint_data: data,
      first_seen_at: timestamp,
      last_seen_at: timestamp,
      occurrence_count: 1,
      promoted_to_fingerprint_id: null,
    };

    const result = await db
      .insertInto("navigation_suggestions")
      .values(newSuggestion)
      .onConflict((oc) =>
        oc.columns(["app_id", "fingerprint_hash"]).doUpdateSet((eb) => ({
          last_seen_at: timestamp,
          occurrence_count: eb("navigation_suggestions.occurrence_count", "+", 1),
        })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return result;
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
    const db = this.getDb();
    if (db.isTransaction) {
      return this.promoteSuggestionWithin(db, suggestionId, nodeId, timestamp);
    }

    return db
      .transaction()
      .execute((trx) =>
        this.withExecutor(trx).promoteSuggestionWithin(trx, suggestionId, nodeId, timestamp),
      );
  }

  private async promoteSuggestionWithin(
    db: Kysely<Database>,
    suggestionId: number,
    nodeId: number,
    timestamp: number,
  ): Promise<NavigationNodeFingerprint> {
    // Get the suggestion
    const suggestion = await db
      .selectFrom("navigation_suggestions")
      .selectAll()
      .where("id", "=", suggestionId)
      .executeTakeFirst();

    if (!suggestion) {
      throw new Error(`Suggestion not found: ${suggestionId}`);
    }

    // Create fingerprint record (using app_id from suggestion)
    const fingerprint = await this.withExecutor(db).getOrCreateFingerprint(
      suggestion.app_id,
      nodeId,
      suggestion.fingerprint_hash,
      suggestion.fingerprint_data,
      timestamp,
    );

    // Link suggestion to fingerprint
    await db
      .updateTable("navigation_suggestions")
      .set({ promoted_to_fingerprint_id: fingerprint.id })
      .where("id", "=", suggestionId)
      .execute();

    logger.info(`[NAV_REPO] Promoted suggestion ${suggestionId} to node ${nodeId}`);

    return fingerprint;
  }

  /**
   * Check if an app has any named navigation nodes.
   */
  async hasNamedNodes(appId: string): Promise<boolean> {
    const db = this.getDb();
    const result = await db
      .selectFrom("navigation_nodes")
      .select(db.fn.countAll<number>().as("count"))
      .where("app_id", "=", appId)
      .executeTakeFirst();

    return Number(result?.count || 0) > 0;
  }

  /**
   * Get unpromoted suggestions for an app.
   */
  async getSuggestions(appId: string): Promise<NavigationSuggestion[]> {
    const db = this.getDb();
    return db
      .selectFrom("navigation_suggestions")
      .selectAll()
      .where("app_id", "=", appId)
      .where("promoted_to_fingerprint_id", "is", null)
      .orderBy("occurrence_count", "desc")
      .execute();
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
    const db = this.getDb();
    const newBuildKey: NewNavigationBuildKey = {
      app_id: appId,
      version_code: versionCode,
      content_hash: contentHash,
    };

    return db
      .insertInto("navigation_build_keys")
      .values(newBuildKey)
      .onConflict((oc) =>
        oc.columns(["app_id", "version_code", "content_hash"]).doUpdateSet((eb) => ({
          app_id: eb.ref("navigation_build_keys.app_id"),
        })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
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
    const db = this.getDb();
    const observation: NewNavigationNodeObservation = {
      node_id: nodeId,
      build_key_id: buildKeyId,
      device_id: deviceId,
      session_uuid: sessionUuid,
      first_seen_at: seenAt,
      last_seen_at: seenAt,
    };

    await db
      .insertInto("navigation_node_observations")
      .values(observation)
      .onConflict((oc) =>
        oc.columns(["node_id", "build_key_id", "device_id", "session_uuid"]).doUpdateSet({
          first_seen_at: sql`min(navigation_node_observations.first_seen_at, ${seenAt})`,
          last_seen_at: sql`max(navigation_node_observations.last_seen_at, ${seenAt})`,
        }),
      )
      .execute();
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
    const db = this.getDb();
    const observation: NewNavigationEdgeObservation = {
      edge_id: edgeId,
      build_key_id: buildKeyId,
      device_id: deviceId,
      session_uuid: sessionUuid,
      first_seen_at: seenAt,
      last_seen_at: seenAt,
    };

    await db
      .insertInto("navigation_edge_observations")
      .values(observation)
      .onConflict((oc) =>
        oc.columns(["edge_id", "build_key_id", "device_id", "session_uuid"]).doUpdateSet({
          first_seen_at: sql`min(navigation_edge_observations.first_seen_at, ${seenAt})`,
          last_seen_at: sql`max(navigation_edge_observations.last_seen_at, ${seenAt})`,
        }),
      )
      .execute();
  }

  /**
   * Read every node-provenance observation for an app in one typed join
   * (nav (app,build) Phase 2, #4985): node_observations ⋈ build_keys, scoped by
   * the node's own `app_id`. Rows are ordered `last_seen_at` desc so the caller's
   * per-node grouping preserves recency order deterministically. `package_id` is
   * the build key's `app_id` (== the queried app), surfaced for the read shape.
   */
  async getNodeProvenanceForApp(appId: string): Promise<NavigationNodeProvenanceRow[]> {
    const db = this.getDb();
    return (
      db
        .selectFrom("navigation_node_observations as obs")
        .innerJoin("navigation_build_keys as bk", "bk.id", "obs.build_key_id")
        .innerJoin("navigation_nodes as n", "n.id", "obs.node_id")
        .where("n.app_id", "=", appId)
        // Constrain the build key to the node's own app: observation rows accept
        // independent entity + build-key ids, so a mis-scoped build key must not
        // surface another app's provenance in this app-union (#4985).
        .whereRef("bk.app_id", "=", "n.app_id")
        .select([
          "obs.node_id as node_id",
          "bk.app_id as package_id",
          "bk.version_code as version_code",
          "bk.content_hash as content_hash",
          "obs.device_id as device_id",
          "obs.session_uuid as session_uuid",
          "obs.last_seen_at as last_seen_at",
        ])
        .orderBy("obs.last_seen_at", "desc")
        .orderBy("obs.device_id", "asc")
        .execute()
    );
  }

  /**
   * Read every edge-provenance observation for an app in one typed join
   * (nav (app,build) Phase 2, #4985), symmetric to
   * {@link getNodeProvenanceForApp}. Keyed by `edge_id` so the caller can union
   * provenance across the multiple edge rows that aggregate into one summary
   * transition.
   */
  async getEdgeProvenanceForApp(appId: string): Promise<NavigationEdgeProvenanceRow[]> {
    const db = this.getDb();
    return (
      db
        .selectFrom("navigation_edge_observations as obs")
        .innerJoin("navigation_build_keys as bk", "bk.id", "obs.build_key_id")
        .innerJoin("navigation_edges as e", "e.id", "obs.edge_id")
        .where("e.app_id", "=", appId)
        // Symmetric to the node query: pin the build key to the edge's own app so
        // a mis-scoped build key cannot leak another app's provenance (#4985).
        .whereRef("bk.app_id", "=", "e.app_id")
        .select([
          "obs.edge_id as edge_id",
          "bk.app_id as package_id",
          "bk.version_code as version_code",
          "bk.content_hash as content_hash",
          "obs.device_id as device_id",
          "obs.session_uuid as session_uuid",
          "obs.last_seen_at as last_seen_at",
        ])
        .orderBy("obs.last_seen_at", "desc")
        .orderBy("obs.device_id", "asc")
        .execute()
    );
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
