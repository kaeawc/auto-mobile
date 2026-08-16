import { logger } from "../../utils/logger";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { BackStackInfo } from "../../models";
import { NavigationRepository } from "../../db/navigationRepository";
import { TelemetryRecorder } from "../telemetry/TelemetryRecorder";
import { TestCoverageRepository } from "../../db/testCoverageRepository";
import { ActionableError } from "../../models/ActionableError";
import type { NavigationEdge as DBNavigationEdge, NavigationNode as DBNavigationNode, TestCoverageSession } from "../../db/types";
import {
  NavigationGraph,
  NavigationEvent,
  HierarchyNavigationEvent,
  NavigationNode,
  NavigationEdge,
  NavigationGraphStats,
  PathResult,
  ToolCallInteraction,
  ExportedGraph,
  NavigationGraphSummary,
  NavigationGraphSummaryEdge,
  NavigationGraphSummaryNode,
  NavigationGraphSummaryProvider,
  NavigationGraphHistoryEdge,
  NavigationGraphHistoryNode,
  NavigationGraphHistoryPage,
  NavigationGraphHistoryProvider,
  NavigationGraphNodeDetail,
  NavigationGraphNodeResource,
  NavigationGraphNodeResourceProvider,
  NavigationAppSummary,
  NavigationAppListProvider,
  NavigationSuggestionInfo,
  NavigationProvenanceRecord,
  UIState,
  ScrollPosition,
  SelectedElement,
} from "../../utils/interfaces/NavigationGraph";
import type {
  NavigationNodeProvenanceRow,
  NavigationEdgeProvenanceRow,
} from "../../db/navigationRepository";

// Re-export types for convenience
export type {
  NavigationEvent,
  NavigationEdge,
  UIState,
};

/**
 * Interface for navigation graph management operations.
 * Provides methods for tracking screen visits, recording navigation events,
 * and querying navigation paths.
 */
export interface NavigationGraphService extends NavigationGraph, NavigationGraphSummaryProvider, NavigationGraphHistoryProvider, NavigationGraphNodeResourceProvider, NavigationAppListProvider {
  // App management
  setCurrentApp(appId: string): Promise<void>;
  getCurrentAppId(): string | null;

  // Build/device provenance (#4984)
  setBuildContext(context: NavigationBuildContext): void;
  clearBuildContext(appId: string): void;

  // Screen tracking
  getCurrentScreen(): string | null;
  recordBackStack(backStack: BackStackInfo): Promise<void>;

  // Navigation events
  recordNavigationEvent(event: NavigationEvent): Promise<void>;
  recordHierarchyNavigation(event: HierarchyNavigationEvent): Promise<void>;

  // Tool call correlation
  recordToolCall(toolName: string, args: Record<string, any>, uiState?: UIState): void;
  updateScrollPosition(scrollPosition: ScrollPosition): void;

  // Pathfinding
  findPath(targetScreen: string): Promise<PathResult>;

  // Graph queries
  getKnownScreens(): Promise<string[]>;
  getNode(screenName: string): Promise<NavigationNode | undefined>;
  getNodeResourceById(nodeId: number): Promise<NavigationGraphNodeResource | null>;
  getNodeResourceByScreen(screenName: string): Promise<NavigationGraphNodeResource | null>;
  getEdgesFrom(screenName: string): Promise<NavigationEdge[]>;
  getEdgesTo(screenName: string): Promise<NavigationEdge[]>;
  getStats(): Promise<NavigationGraphStats>;

  // Graph operations
  clearCurrentGraph(): Promise<void>;
  clearAllGraphs(): Promise<void>;
  exportGraph(): Promise<ExportedGraph>;
  exportGraphSummary(): Promise<NavigationGraphSummary>;
  exportGraphSummaryForApp(appId: string | null): Promise<NavigationGraphSummary>;
  exportGraphHistory(options?: { cursor?: string; limit?: number }): Promise<NavigationGraphHistoryPage>;

  // Screenshot management
  updateNodeScreenshot(appId: string, screenName: string, screenshotPath: string | null): Promise<void>;

  // Suggestions
  getSuggestions(): Promise<NavigationSuggestionInfo[]>;
  promoteSuggestion(suggestionId: number, screenName: string): Promise<void>;

  // Test coverage
  startTestSession(sessionUuid: string): Promise<void>;
  endTestSession(): Promise<void>;
  getActiveTestSession(): TestCoverageSession | null;

  // Listeners
  setGraphUpdateListener(listener: (() => void | Promise<void>) | null): void;
}

type HistoryCursor = {
  timestamp: number;
  id: number;
};

/**
 * Build/device provenance context for a graph mutation (#4984). The build key is
 * (packageId=appId, versionCode, contentHash); deviceId names the device the
 * mutation was observed on. appId is carried so a context resolved for one app is
 * never applied to another when a session observes multiple apps on a device —
 * a stale context falls back to the default build key instead of mis-stamping.
 */
export interface NavigationBuildContext {
  appId: string;
  deviceId: string;
  versionCode: number;
  contentHash: string;
}

/** Non-null legacy sentinel used when a provenance dimension is unknown (#4984). */
const LEGACY_PROVENANCE_SENTINEL = "legacy";

/** Immutable provenance snapshot captured once per event and shared by its writes (#4984). */
interface ResolvedProvenance {
  versionCode: number;
  contentHash: string;
  deviceId: string;
  sessionUuid: string;
}

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
  b: NavigationProvenanceRecord
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

function nodeProvenanceRowToRecord(
  row: NavigationNodeProvenanceRow
): NavigationProvenanceRecord {
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

function edgeProvenanceRowToRecord(
  row: NavigationEdgeProvenanceRow
): NavigationProvenanceRecord {
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
  rows: NavigationNodeProvenanceRow[]
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
  rows: NavigationEdgeProvenanceRow[]
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
  records: NavigationProvenanceRecord[]
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

/**
 * Manages the navigation graph with SQLite persistence.
 * Tracks screen visits and correlates navigation events with tool calls.
 */
export class NavigationGraphManager implements NavigationGraphService {
  private static instance: NavigationGraphManager | null = null;
  // Per-session instances for multi-agent isolation
  private static sessionInstances: Map<string, NavigationGraphManager> = new Map();
  // Session UUIDs that have been released (#4984). Session UUIDs are never reused, so
  // a getInstanceForSession() for a released id is a post-release stray event — it
  // must resolve to the unattributed global singleton, never recreate a manager that
  // would attribute the observation to the ended session. Bounded to avoid unbounded
  // growth over a long-lived daemon.
  private static releasedSessions: Set<string> = new Set();
  private static readonly RELEASED_SESSIONS_CAP = 4096;

  private repository: NavigationRepository;
  private testCoverageRepository: TestCoverageRepository;
  private timer: Timer;
  private currentAppId: string | null = null;
  private currentScreen: string | null = null;
  private graphUpdateListeners: Array<() => void | Promise<void>> = [];

  // Session + build/device provenance (#4984). sessionUuid identifies the owning
  // agent session; the build context (deviceId, versionCode, contentHash) is set
  // per app by the CtrlProxy client that binds a device. Keyed by app_id so a
  // context resolved for one app is never applied to another when a session
  // observes multiple apps on a device. When no context exists for the current app
  // (no device bound yet, or an unresolved content hash), mutations record under
  // the default build key so a write never blocks on — or fails because of —
  // provenance resolution.
  private sessionUuid: string | null;
  private buildContexts: Map<string, NavigationBuildContext> = new Map();

  // Tool call history kept in memory for correlation (transient data)
  private toolCallHistory: ToolCallInteraction[] = [];

  // Test coverage tracking
  private activeTestSession: TestCoverageSession | null = null;

  private readonly HISTORY_PAGE_DEFAULT = 50;
  private readonly HISTORY_PAGE_MAX = 200;

  // Correlation window: tool call must occur 0-2000ms before navigation event
  private readonly TOOL_CALL_CORRELATION_WINDOW_MS = 2000;
  // Keep tool calls for 10 seconds
  private readonly TOOL_CALL_HISTORY_TTL_MS = 10000;

  // Active navigation window: fingerprints seen within this window of an SDK event are correlated
  private readonly ACTIVE_NAVIGATION_WINDOW_MS = 1000;

  // Track active navigation from SDK events for fingerprint correlation
  private activeNavigation: {
    nodeId: number;
    screenName: string;
    startTime: number;
  } | null = null;

  constructor(
    repository?: NavigationRepository,
    testCoverageRepository?: TestCoverageRepository,
    timer: Timer = defaultTimer,
    sessionUuid: string | null = null
  ) {
    this.repository = repository ?? new NavigationRepository();
    this.testCoverageRepository = testCoverageRepository ?? new TestCoverageRepository();
    this.timer = timer;
    this.sessionUuid = sessionUuid;
  }

  /**
   * Set the build/device provenance context for `context.appId` (#4984). Called by
   * the CtrlProxy client that owns the device; the content hash is resolved eagerly
   * (and cached) at bind time so nav events that arrive later record under the real
   * build key. Stored per app so switching apps never applies one app's context to
   * another.
   */
  public setBuildContext(context: NavigationBuildContext): void {
    this.buildContexts.set(context.appId, context);
  }

  /**
   * Drop the build context for an app (#4984), so its next mutation falls to the
   * default key until re-resolved. Called on a package update/reinstall/removal.
   */
  public clearBuildContext(appId: string): void {
    this.buildContexts.delete(appId);
  }

  /**
   * Get the singleton instance of NavigationGraphManager.
   * Used for non-daemon single-agent mode.
   */
  public static getInstance(): NavigationGraphManager {
    if (!NavigationGraphManager.instance) {
      NavigationGraphManager.instance = new NavigationGraphManager();
    }
    return NavigationGraphManager.instance;
  }

  /**
   * Get or create a session-scoped instance for multi-agent isolation.
   * Each session gets its own transient state (currentAppId, currentScreen,
   * toolCallHistory, activeTestSession) while sharing the SQLite repositories.
   */
  public static getInstanceForSession(sessionId: string): NavigationGraphManager {
    let instance = NavigationGraphManager.sessionInstances.get(sessionId);
    if (!instance) {
      // A released session never legitimately returns (UUIDs are unique), so a
      // request for one here is a stray post-release event: route it to the
      // unattributed global singleton instead of minting a manager that would
      // attribute the observation to the ended session (#4984).
      if (NavigationGraphManager.releasedSessions.has(sessionId)) {
        return NavigationGraphManager.getInstance();
      }
      instance = new NavigationGraphManager(undefined, undefined, undefined, sessionId);
      NavigationGraphManager.sessionInstances.set(sessionId, instance);
    }
    return instance;
  }

  /**
   * Clear a session's released-tombstone (#4984). Session UUIDs are normally not
   * reused, but `setActiveDevice` releases an existing session and immediately
   * re-creates it with the SAME uuid on another device — so when a session is
   * (re)bound, drop any tombstone so getInstanceForSession builds it a real manager
   * again instead of routing it to the unattributed global.
   */
  public static clearReleasedSession(sessionId: string): void {
    NavigationGraphManager.releasedSessions.delete(sessionId);
  }

  /**
   * Release a session-scoped instance and its transient state.
   */
  public static releaseSession(sessionId: string): void {
    const instance = NavigationGraphManager.sessionInstances.get(sessionId);
    if (instance) {
      instance.activeTestSession = null;
      instance.toolCallHistory = [];
      instance.activeNavigation = null;
      instance.graphUpdateListeners = [];
      NavigationGraphManager.sessionInstances.delete(sessionId);
      logger.debug(`[NAV_GRAPH] Released session instance: ${sessionId}`);
    }
    // Mark released even if no instance existed yet, so a later stray event for this
    // session resolves to the unattributed global rather than minting a manager for
    // the ended session (#4984). Bounded FIFO to cap long-daemon growth.
    NavigationGraphManager.releasedSessions.add(sessionId);
    if (NavigationGraphManager.releasedSessions.size > NavigationGraphManager.RELEASED_SESSIONS_CAP) {
      const oldest = NavigationGraphManager.releasedSessions.values().next().value;
      if (oldest !== undefined) {
        NavigationGraphManager.releasedSessions.delete(oldest);
      }
    }
  }

  /**
   * Reset the singleton instance (for testing).
   */
  public static resetInstance(): void {
    NavigationGraphManager.instance = null;
    NavigationGraphManager.sessionInstances.clear();
    NavigationGraphManager.releasedSessions.clear();
  }

  /**
   * Install a pre-built instance as the singleton (for testing only).
   *
   * Lets a test back the singleton with an in-memory database so consumers that
   * resolve the manager via `getInstance()` (e.g. AndroidCtrlProxyClient) exercise
   * deterministic, migration-gate-free DB writes instead of the real file DB. Using
   * `getInstance()` alone would lazily build a manager on the shared `getDatabase()`
   * singleton, whose first-use migration + file IO run on real wall-clock time and
   * make async writes race the assertions. Pair with `resetInstance()` in teardown.
   */
  public static setInstanceForTesting(instance: NavigationGraphManager): void {
    NavigationGraphManager.instance = instance;
  }

  /**
   * Install a session-scoped instance for testing only.
   *
   * This preserves the production session lookup path while allowing focused
   * tests to use an in-memory database instead of the shared file database.
   */
  public static setInstanceForSessionForTesting(
    sessionId: string,
    instance: NavigationGraphManager
  ): void {
    // Installing an instance clears any released-mark so the id resolves to it.
    NavigationGraphManager.releasedSessions.delete(sessionId);
    NavigationGraphManager.sessionInstances.set(sessionId, instance);
  }

  /**
   * Create a new instance for testing with injected dependencies.
   *
   * Precondition for recordNavigationEvent's atomicity: `repository` and
   * `testCoverageRepository` MUST resolve to the same underlying connection
   * (the default is both unbound → shared `getDatabase()` singleton). The
   * transactional write opens one transaction on the navigation connection and
   * enlists the coverage repo onto it via withExecutor; injecting a coverage
   * repo bound to a DIFFERENT Kysely handle would split writes across
   * connections and silently defeat the rollback guarantee. Tests that inject a
   * db must pass the SAME instance to both repositories.
   *
   * This precondition is now enforced at runtime: recordNavigationEvent calls
   * assertSharedConnection() before opening the transaction, so a foreign-bound
   * coverage repo throws an ActionableError instead of silently splitting writes.
   */
  public static createForTesting(
    repository?: NavigationRepository,
    testCoverageRepository?: TestCoverageRepository,
    timer?: Timer,
    sessionUuid?: string
  ): NavigationGraphManager {
    return new NavigationGraphManager(repository, testCoverageRepository, timer, sessionUuid ?? null);
  }

  /**
   * Start a test coverage session.
   * This enables tracking which nodes and edges are visited during tests.
   */
  public async startTestSession(sessionUuid: string): Promise<void> {
    if (!this.currentAppId) {
      logger.warn(`[TEST_COVERAGE] Cannot start test session - no current app set`);
      return;
    }

    this.activeTestSession = await this.testCoverageRepository.getOrCreateSession(
      sessionUuid,
      this.currentAppId
    );

    logger.info(`[TEST_COVERAGE] Started test session: ${sessionUuid} for app: ${this.currentAppId}`);
  }

  /**
   * End the current test coverage session.
   */
  public async endTestSession(): Promise<void> {
    if (!this.activeTestSession) {
      return;
    }

    await this.testCoverageRepository.endSession(this.activeTestSession.session_uuid);
    logger.info(`[TEST_COVERAGE] Ended test session: ${this.activeTestSession.session_uuid}`);
    this.activeTestSession = null;
  }

  /**
   * Get the active test coverage session (if any).
   */
  public getActiveTestSession(): TestCoverageSession | null {
    return this.activeTestSession;
  }

  /**
   * Set the current app being navigated.
   * Creates the app record in the database if it doesn't exist.
   */
  public async setCurrentApp(appId: string): Promise<void> {
    if (this.currentAppId === appId) {
      return;
    }

    this.currentAppId = appId;
    this.currentScreen = null;

    // Ensure app exists in database
    await this.repository.getOrCreateApp(appId);
    logger.info(`[NAVIGATION_GRAPH] Set current app: ${appId}`);
    this.notifyGraphUpdated();
  }

  /**
   * Get the current app ID.
   */
  public getCurrentAppId(): string | null {
    return this.currentAppId;
  }

  /**
   * Resolve the provenance dimensions for the current app (#4984): the build key
   * (versionCode + contentHash), the deviceId, and the sessionUuid. Looked up by
   * app_id, so a context resolved for a different app is never applied here. When
   * no context exists for the current app the mutation records under the default
   * build key with non-null legacy sentinels — today's single-build behavior as the
   * degenerate default.
   *
   * Capture ONE snapshot per event (before opening the transaction) and thread it
   * into both the node and edge writes: a fire-and-forget hash resolution can call
   * setBuildContext mid-transaction, and resolving separately per observation would
   * split a single transition across two build keys.
   */
  private resolveProvenance(appId: string | null): ResolvedProvenance {
    const sessionUuid = this.sessionUuid ?? LEGACY_PROVENANCE_SENTINEL;
    const ctx = appId ? this.buildContexts.get(appId) : undefined;
    if (ctx) {
      return {
        versionCode: ctx.versionCode,
        contentHash: ctx.contentHash,
        deviceId: ctx.deviceId,
        sessionUuid,
      };
    }
    logger.debug(
      `[NAVIGATION_GRAPH] No matching build context for ${appId ?? "?"}; ` +
      `recording provenance under the default build key`
    );
    return { versionCode: 0, contentHash: "", deviceId: LEGACY_PROVENANCE_SENTINEL, sessionUuid };
  }

  /**
   * Record a per-node provenance observation inside the caller's transaction
   * (#4984). Must run on the transaction-bound repository so it commits atomically
   * with the node mutation, using the caller's pre-captured provenance snapshot.
   */
  private async recordNodeProvenance(
    repository: NavigationRepository,
    appId: string,
    nodeId: number,
    timestamp: number,
    provenance: ResolvedProvenance
  ): Promise<void> {
    const buildKey = await repository.getOrCreateBuildKey(appId, provenance.versionCode, provenance.contentHash);
    await repository.recordNodeObservation(nodeId, buildKey.id, provenance.deviceId, provenance.sessionUuid, timestamp);
  }

  /**
   * Record a per-edge provenance observation inside the caller's transaction (#4984),
   * using the same provenance snapshot as the node write for that transition.
   */
  private async recordEdgeProvenance(
    repository: NavigationRepository,
    appId: string,
    edgeId: number,
    timestamp: number,
    provenance: ResolvedProvenance
  ): Promise<void> {
    const buildKey = await repository.getOrCreateBuildKey(appId, provenance.versionCode, provenance.contentHash);
    await repository.recordEdgeObservation(edgeId, buildKey.id, provenance.deviceId, provenance.sessionUuid, timestamp);
  }

  /**
   * Record back stack information for the current screen.
   * Updates the current node with back stack depth and task ID.
   */
  public async recordBackStack(backStack: BackStackInfo): Promise<void> {
    if (!this.currentAppId || !this.currentScreen) {
      logger.debug(`[NAVIGATION_GRAPH] Cannot record back stack - no current app or screen`);
      return;
    }

    const appId = this.currentAppId;
    const screenName = this.currentScreen;

    // Persist the back-stack update + app touch atomically (#4931): both run on the
    // transaction-bound repository so a throw rolls back together and the exclusive
    // connection is never held across non-DB work.
    await this.repository.runInTransaction(async trx => {
      const repository = this.repository.withExecutor(trx);
      await repository.updateNodeBackStack(
        appId,
        screenName,
        backStack.depth,
        backStack.currentTaskId
      );
      await repository.touchApp(appId);
    });

    logger.debug(
      `[NAVIGATION_GRAPH] Updated back stack for ${screenName}: ` +
      `depth=${backStack.depth}, taskId=${backStack.currentTaskId}`
    );
  }

  /**
   * Record a navigation event from WebSocket.
   * If the event contains an applicationId, automatically sets/switches the current app.
   * This creates a "named node" in the navigation graph.
   */
  public async recordNavigationEvent(event: NavigationEvent): Promise<void> {
    // Auto-set current app from navigation event if provided
    if (event.applicationId && event.applicationId !== this.currentAppId) {
      await this.setCurrentApp(event.applicationId);
    }

    if (!this.currentAppId) {
      logger.warn(`[NAVIGATION_GRAPH] Cannot record event - no current app set`);
      return;
    }

    const appId = this.currentAppId;
    const screenName = event.destination;
    const timestamp = event.timestamp ?? this.timer.now();

    // Capture the previous screen up front. The edge is computed from it and the
    // in-memory field assignments below only happen AFTER the transaction commits,
    // so on rollback `this.currentScreen` stays the previous screen and the next
    // event still computes the correct edge.
    const previousScreen = this.currentScreen;

    // Get modal stack from the most recent tool call (if any)
    const recentToolCall = this.findCorrelatedToolCall(timestamp);
    const currentModalStack = recentToolCall?.uiState?.modalStack;

    // Snapshot provenance ONCE for this transition so the node and edge observations
    // share one build key even if a fire-and-forget hash lands mid-transaction (#4984).
    const provenance = this.resolveProvenance(appId);

    // Persist the whole graph write atomically across BOTH repos via the shared helper,
    // which owns the assertSharedConnection() precondition and the bind-both-repos
    // preamble (#3075). Every read and write inside the callback runs on the transaction
    // (via withExecutor) — a stray singleton query here would deadlock the daemon's only
    // connection (bunSqliteDialect). Keep the body to DB statements only: telemetry push,
    // notifications, screenshot capture and in-memory field assignments stay OUTSIDE so
    // the exclusive connection is not held across non-DB IO, and so they never run when
    // the transaction rolls back.
    const node = await this.runBothReposInTransaction(async (repository, testCoverageRepository) => {
      // Get or create node and update visit count
      const n = await repository.getOrCreateNode(appId, screenName, timestamp);

      // Record per-node provenance for the current build/device/session (#4984),
      // in the same transaction as the node mutation.
      await this.recordNodeProvenance(repository, appId, n.id, timestamp, provenance);

      // Record node visit for test coverage if session is active
      if (this.activeTestSession) {
        await testCoverageRepository.recordNodeVisit(
          this.activeTestSession.id,
          n.id,
          timestamp
        );
      }

      // Update node modals if present
      if (currentModalStack && currentModalStack.length > 0) {
        const modalIds = currentModalStack.map(m => m.identifier || `${m.type}-${m.layer}`);
        await repository.setNodeModals(n.id, modalIds);

        logger.info(
          `[NAVIGATION_GRAPH] Screen ${screenName} has ${modalIds.length} modal(s)`
        );
      }

      // Create edge from previous screen to current screen
      if (previousScreen && previousScreen !== screenName) {
        const interaction = this.findCorrelatedToolCall(timestamp);

        const toolName = interaction?.toolName || null;
        const toolArgs = interaction?.args || null;

        const edge = await repository.createEdge(
          appId,
          previousScreen,
          screenName,
          toolName,
          toolArgs,
          timestamp
        );

        // Record per-edge provenance using the SAME snapshot as the node (#4984).
        await this.recordEdgeProvenance(repository, appId, edge.id, timestamp, provenance);

        // Record edge traversal for test coverage if session is active
        if (this.activeTestSession) {
          await testCoverageRepository.recordEdgeTraversal(
            this.activeTestSession.id,
            edge.id,
            timestamp
          );
        }

        // Store UI elements if present in interaction
        if (interaction?.uiState?.selectedElements) {
          await this.storeUIElements(
            repository,
            edge.id,
            interaction.uiState.selectedElements,
            timestamp
          );
        }

        // Store modal stacks for from/to
        const fromNode = await repository.getNode(appId, previousScreen);
        if (fromNode) {
          const fromModals = await repository.getNodeModals(fromNode.id);
          if (fromModals.length > 0) {
            await repository.setEdgeModals(edge.id, "from", fromModals);
          }
        }

        if (currentModalStack && currentModalStack.length > 0) {
          const toModalIds = currentModalStack.map(
            m => m.identifier || `${m.type}-${m.layer}`
          );
          await repository.setEdgeModals(edge.id, "to", toModalIds);
        }

        // Store scroll position if present
        if (interaction?.uiState?.scrollPosition) {
          await this.storeScrollPosition(
            repository,
            edge.id,
            interaction.uiState.scrollPosition,
            timestamp
          );
        }
      }

      await repository.touchApp(appId);
      return n;
    });

    // ---- Post-commit side effects (never inside the transaction) ----

    // Set active navigation state for fingerprint correlation. Fingerprints seen
    // within ACTIVE_NAVIGATION_WINDOW_MS will be correlated to this node.
    this.activeNavigation = {
      nodeId: node.id,
      screenName: screenName,
      startTime: timestamp,
    };

    this.currentScreen = screenName;
    this.notifyGraphUpdated();

    // Push to telemetry dashboard via TelemetryRecorder (has device context for subscriber filtering)
    TelemetryRecorder.getInstance().recordNavigationEvent({
      timestamp,
      applicationId: appId,
      destination: screenName,
      source: event.source ?? null,
      arguments: event.arguments ?? null,
      metadata: event.metadata ?? null,
      triggeringInteraction: event.triggeringInteraction ?? null,
      screenshotUri: `automobile:navigation/nodes/${node.id}/screenshot`,
    });
  }

  /**
   * Run a graph write that spans BOTH the navigation and test-coverage repositories
   * inside a single transaction, owning the shared-connection precondition so no
   * caller can forget it (#3075). This is the one place the assert + bind-both-repos
   * preamble lives, so a future third both-repos writer inherits the guard for free
   * (the exact failure mode #2968/#2980 guard against).
   *
   * It (1) asserts assertSharedConnection() once, (2) opens a transaction on the
   * navigation connection, and (3) enlists both repos onto that same `trx` via
   * withExecutor before invoking `fn` with the two bound repos. Every read and write
   * inside `fn` runs on `trx` — a stray singleton query would deadlock the daemon's
   * only connection (bunSqliteDialect).
   *
   * Callers keep in-memory field updates, notifyGraphUpdated and telemetry OUTSIDE
   * `fn` (post-commit): this helper owns only the DB-atomic preamble, matching the
   * convention that side effects never run inside the transaction or on rollback.
   *
   * Not for the single-repo writers: promoteSuggestion enlists only the navigation
   * repo and deliberately carries no coverage binding or shared-connection assertion,
   * so it stays on its own runInTransaction path.
   */
  private async runBothReposInTransaction<T>(
    fn: (
      navigationRepository: NavigationRepository,
      testCoverageRepository: TestCoverageRepository
    ) => Promise<T>
  ): Promise<T> {
    // Enforce the shared-connection precondition BEFORE reserving the connection: the
    // transaction is opened on the navigation connection and the coverage repo is
    // enlisted onto that same `trx`, so a coverage repo bound to a DIFFERENT connection
    // would split writes and defeat the rollback. Holds by construction in production
    // (both default to the getDatabase() singleton); see assertSharedConnection.
    this.assertSharedConnection();

    return this.repository.runInTransaction(async trx => {
      const navigationRepository = this.repository.withExecutor(trx);
      const testCoverageRepository = this.testCoverageRepository.withExecutor(trx);
      return fn(navigationRepository, testCoverageRepository);
    });
  }

  /**
   * Assert that the navigation and test-coverage repositories resolve to the same
   * underlying connection — the precondition for the two-repo graph writes' single
   * transaction to cover both repos' writes atomically. Invoked from
   * runBothReposInTransaction, which is the sole owner of this precondition.
   *
   * Both default to the getDatabase() singleton, so this holds by construction in
   * production; the guard exists so a mistakenly foreign-bound coverage repo
   * (e.g. injected in a test or a future refactor) fails loudly here instead of
   * silently splitting writes across connections and defeating the rollback.
   */
  private assertSharedConnection(): void {
    if (this.repository.resolveConnection() !== this.testCoverageRepository.resolveConnection()) {
      throw new ActionableError(
        "NavigationGraphManager: the navigation and test-coverage repositories resolve to " +
        "different database connections. The two-repo graph writes open one transaction on the " +
        "navigation connection and enlist coverage writes onto it; a foreign-bound coverage " +
        "repo would split writes across connections and silently defeat the rollback guarantee. " +
        "Both repositories must share the same connection (both default to the getDatabase() singleton)."
      );
    }
  }

  /**
   * Record a navigation event detected from view hierarchy changes.
   * This does NOT create new nodes - it only:
   * 1. Updates existing nodes if fingerprint is already correlated
   * 2. Correlates fingerprint if within active navigation window
   * 3. Creates a suggestion if app has named nodes but fingerprint is uncorrelated
   * 4. Does nothing if app has no named nodes (SDK not integrated)
   */
  public async recordHierarchyNavigation(event: HierarchyNavigationEvent): Promise<void> {
    // Auto-set current app from package name if provided
    if (event.packageName && event.packageName !== this.currentAppId) {
      await this.setCurrentApp(event.packageName);
    }

    if (!this.currentAppId) {
      logger.warn(`[NAVIGATION_GRAPH] Cannot record hierarchy navigation - no current app set`);
      return;
    }

    const fingerprintHash = event.toFingerprint;
    const fingerprintData = event.fingerprintData || JSON.stringify({ hash: fingerprintHash });
    const timestamp = event.timestamp;

    // Snapshot the FULL provenance (app + device + build key) ONCE before the first
    // await: reading only appId early but re-reading the mutable build/device context
    // after the fingerprint lookup would let a concurrent event (a second unbound
    // device routing through the global manager) swap the context mid-lookup, stamping
    // this reach with another device's identity/hash. Capturing everything up front and
    // threading the immutable snapshot means no code path re-reads mutable state after
    // any await (#4984).
    const appId = this.currentAppId;
    const provenance = this.resolveProvenance(appId);

    // Case 1: Check if fingerprint is already correlated to a named node (scoped to this app)
    const existingNode = await this.repository.getNodeByFingerprint(appId, fingerprintHash);
    if (existingNode) {

      // Persist the counter writes atomically across BOTH repos via the shared helper,
      // which owns the assertSharedConnection() precondition and the bind-both-repos
      // preamble (#3075): updateNodeVisit + coverage recordNodeVisit + touchApp span two
      // repos on the shared connection, so a mid-sequence throw (e.g. the coverage
      // recordNodeVisit) rolls back the node-visit increment too instead of leaving the
      // graph partially applied. In-memory field updates and notifyGraphUpdated stay
      // OUTSIDE so they never run on rollback and the exclusive connection is not held
      // across non-DB work.
      await this.runBothReposInTransaction(async (repository, testCoverageRepository) => {
        // Update the existing node's visit count and last_seen_at
        await repository.updateNodeVisit(existingNode.id, timestamp);

        // Record per-node provenance for this reach (#4984), same transaction.
        await this.recordNodeProvenance(repository, appId, existingNode.id, timestamp, provenance);

        // Record node visit for test coverage if session is active
        if (this.activeTestSession) {
          await testCoverageRepository.recordNodeVisit(
            this.activeTestSession.id,
            existingNode.id,
            timestamp
          );
        }

        await repository.touchApp(appId);
      });

      // ---- Post-commit side effects (never inside the transaction) ----
      // Update current screen to the named screen
      this.currentScreen = existingNode.screen_name;

      logger.debug(
        `[NAVIGATION_GRAPH] Hierarchy fingerprint matched node: ${existingNode.screen_name}`
      );

      this.notifyGraphUpdated();
      return;
    }

    // Case 2: Check if within active navigation window - correlate fingerprint to active node
    if (this.activeNavigation) {
      const timeSinceNavigation = timestamp - this.activeNavigation.startTime;

      if (timeSinceNavigation >= 0 && timeSinceNavigation <= this.ACTIVE_NAVIGATION_WINDOW_MS) {
        // Correlate this fingerprint to the active named node (scoped to this app)
        await this.repository.getOrCreateFingerprint(
          this.currentAppId,
          this.activeNavigation.nodeId,
          fingerprintHash,
          fingerprintData,
          timestamp
        );

        logger.info(
          `[NAVIGATION_GRAPH] Correlated fingerprint to ${this.activeNavigation.screenName} ` +
          `(${timeSinceNavigation}ms after navigation)`
        );

        // Clear active navigation after correlation
        this.activeNavigation = null;
        return;
      }
    }

    // Case 3: Check if app has named nodes - create suggestion
    const hasNamedNodes = await this.repository.hasNamedNodes(this.currentAppId);
    if (hasNamedNodes) {
      // Add as a suggestion for future promotion
      await this.repository.addOrUpdateSuggestion(
        this.currentAppId,
        fingerprintHash,
        fingerprintData,
        timestamp
      );

      logger.debug(
        `[NAVIGATION_GRAPH] Added fingerprint suggestion: ${fingerprintHash.substring(0, 12)}...`
      );
      return;
    }

    // Case 4: App has no named nodes - do nothing
    // This app doesn't have SDK integration yet, so we don't track hierarchy-only navigation
    logger.debug(
      `[NAVIGATION_GRAPH] Ignoring hierarchy navigation - app has no named nodes`
    );
  }

  /**
   * Store UI elements used in an edge transition.
   *
   * `repository` is the transaction-bound repository from the enclosing
   * recordNavigationEvent write, so these element writes are part of the same
   * atomic transaction. getOrCreateUIElement runs directly on the executor (it
   * detects it is already inside a transaction) rather than opening a nested one.
   */
  private async storeUIElements(
    repository: NavigationRepository,
    edgeId: number,
    selectedElements: SelectedElement[],
    timestamp: number
  ): Promise<void> {
    if (!this.currentAppId || selectedElements.length === 0) {
      return;
    }

    const elementIds: number[] = [];

    for (const selected of selectedElements) {
      const element = await repository.getOrCreateUIElement(
        this.currentAppId,
        {
          text: selected.text,
          resourceId: selected.resourceId,
          contentDescription: selected.contentDesc,
        },
        timestamp
      );
      elementIds.push(element.id);
    }

    await repository.linkUIElementsToEdge(edgeId, elementIds);
  }

  /**
   * Store scroll position for an edge.
   *
   * `repository` is the transaction-bound repository from the enclosing
   * recordNavigationEvent write, so these writes are part of the same atomic
   * transaction.
   */
  private async storeScrollPosition(
    repository: NavigationRepository,
    edgeId: number,
    scrollPosition: ScrollPosition,
    timestamp: number
  ): Promise<void> {
    if (!this.currentAppId) {
      return;
    }

    // Store the target element
    const targetElement = await repository.getOrCreateUIElement(
      this.currentAppId,
      {
        text: scrollPosition.targetElement.text,
        resourceId: scrollPosition.targetElement.resourceId,
        contentDescription: scrollPosition.targetElement.contentDesc,
      },
      timestamp
    );

    // Store the container element if present
    let containerElementId: number | undefined;
    if (scrollPosition.container) {
      const containerElement = await repository.getOrCreateUIElement(
        this.currentAppId,
        {
          text: scrollPosition.container.text,
          resourceId: scrollPosition.container.resourceId,
          contentDescription: scrollPosition.container.contentDesc,
        },
        timestamp
      );
      containerElementId = containerElement.id;
    }

    await repository.setScrollPosition(
      edgeId,
      targetElement.id,
      scrollPosition.direction,
      containerElementId,
      scrollPosition.speed
    );
  }

  /**
   * Record a tool call for correlation with future navigation events.
   */
  public recordToolCall(toolName: string, args: Record<string, any>, uiState?: UIState): void {
    const timestamp = this.timer.now();

    this.toolCallHistory.push({
      toolName,
      args,
      timestamp,
      uiState,
    });

    const uiStateInfo = uiState?.selectedElements.length
      ? ` (UI: ${uiState.selectedElements.map(e => e.text || e.resourceId).join(", ")})`
      : "";
    const modalInfo = uiState?.modalStack?.length
      ? ` [${uiState.modalStack.length} modal(s)]`
      : "";
    logger.debug(`[NAVIGATION_GRAPH] Tool call recorded: ${toolName} at ${timestamp}${uiStateInfo}${modalInfo}`);

    // Clean up old tool calls
    this.cleanupToolCallHistory();
  }

  /**
   * Update the most recent swipeOn tool call with scroll position information.
   * This is called after a swipeOn with lookFor completes successfully.
   */
  public updateScrollPosition(scrollPosition: ScrollPosition): void {
    if (this.toolCallHistory.length === 0) {
      logger.debug(`[NAVIGATION_GRAPH] Cannot update scroll position: no tool calls`);
      return;
    }

    // Find the most recent swipeOn tool call
    const recentSwipeOn = [...this.toolCallHistory]
      .reverse()
      .find(tc => tc.toolName === "swipeOn");

    if (!recentSwipeOn) {
      logger.debug(`[NAVIGATION_GRAPH] No recent swipeOn tool call to update`);
      return;
    }

    // Update the UI state with scroll position
    if (!recentSwipeOn.uiState) {
      recentSwipeOn.uiState = {
        selectedElements: [],
        scrollPosition,
      };
    } else {
      recentSwipeOn.uiState.scrollPosition = scrollPosition;
    }

    logger.debug(
      `[NAVIGATION_GRAPH] Updated scroll position for swipeOn: ` +
        `target=${scrollPosition.targetElement.text || scrollPosition.targetElement.resourceId}, ` +
        `direction=${scrollPosition.direction}`
    );
  }

  /**
   * Remove tool calls older than TTL.
   */
  private cleanupToolCallHistory(): void {
    const cutoff = this.timer.now() - this.TOOL_CALL_HISTORY_TTL_MS;
    const before = this.toolCallHistory.length;
    this.toolCallHistory = this.toolCallHistory.filter(tc => tc.timestamp >= cutoff);
    const removed = before - this.toolCallHistory.length;
    if (removed > 0) {
      logger.debug(`[NAVIGATION_GRAPH] Cleaned up ${removed} old tool calls`);
    }
  }

  /**
   * Find a tool call that likely caused a navigation event.
   * Looks for tool calls within the correlation window BEFORE the navigation event.
   */
  private findCorrelatedToolCall(navigationTimestamp: number): ToolCallInteraction | undefined {
    // Look for tool calls within correlation window BEFORE navigation event
    const candidates = this.toolCallHistory.filter(tc => {
      const timeDiff = navigationTimestamp - tc.timestamp;
      return timeDiff >= 0 && timeDiff <= this.TOOL_CALL_CORRELATION_WINDOW_MS;
    });

    if (candidates.length === 0) {
      return undefined;
    }

    // Return the most recent tool call before navigation
    const mostRecent = candidates[candidates.length - 1];
    logger.debug(
      `[NAVIGATION_GRAPH] Correlated tool call: ${mostRecent.toolName} ` +
        `(${navigationTimestamp - mostRecent.timestamp}ms before navigation)`
    );
    return mostRecent;
  }

  /**
   * Get the current screen name (runtime state).
   */
  public getCurrentScreen(): string | null {
    return this.currentScreen;
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

    // Get all edges for BFS
    const dbEdges = await this.repository.getEdges(this.currentAppId);

    const edgesBySource = new Map<string, DBNavigationEdge[]>();
    for (const edge of dbEdges) {
      const source = edge.from_screen;
      const outgoingEdges = edgesBySource.get(source);
      if (outgoingEdges) {
        outgoingEdges.push(edge);
      } else {
        edgesBySource.set(source, [edge]);
      }
    }

    // BFS to find shortest path
    const queue: string[] = [startScreen];
    let queueHead = 0;
    const visited = new Set<string>([startScreen]);
    const predecessor = new Map<string, DBNavigationEdge>();

    while (queueHead < queue.length) {
      const screen = queue[queueHead++];
      const outgoingEdges = edgesBySource.get(screen) ?? [];

      for (const edge of outgoingEdges) {
        if (edge.to_screen === targetScreen) {
          predecessor.set(edge.to_screen, edge);
          const pathEdges = await this.convertDBEdgesToNavigationEdges(
            this.reconstructPath(startScreen, targetScreen, predecessor)
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
    };
  }

  private reconstructPath(
    startScreen: string,
    targetScreen: string,
    predecessor: Map<string, DBNavigationEdge>
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
    dbEdges: DBNavigationEdge[]
  ): Promise<NavigationEdge[]> {
    const edges: NavigationEdge[] = [];

    for (const dbEdge of dbEdges) {
      const edge: NavigationEdge = {
        from: dbEdge.from_screen,
        to: dbEdge.to_screen,
        timestamp: dbEdge.timestamp,
        edgeType: dbEdge.tool_name ? "tool" : "unknown",
      };

      if (dbEdge.tool_name) {
        edge.interaction = {
          toolName: dbEdge.tool_name,
          args: dbEdge.tool_args ? JSON.parse(dbEdge.tool_args) : {},
          timestamp: dbEdge.timestamp,
        };

        // Load UI elements
        const uiElements = await this.repository.getUIElementsForEdge(dbEdge.id);
        if (uiElements.length > 0) {
          edge.interaction.uiState = {
            selectedElements: uiElements.map(el => ({
              text: el.text || undefined,
              resourceId: el.resource_id || undefined,
              contentDesc: el.content_description || undefined,
            })),
          };
        }

        // Load scroll position
        const scrollPos = await this.repository.getScrollPosition(dbEdge.id);
        if (scrollPos) {
          // Initialize uiState if not already present
          if (!edge.interaction.uiState) {
            edge.interaction.uiState = {
              selectedElements: [],
            };
          }
          edge.interaction.uiState.scrollPosition = {
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
            edge.interaction.uiState.scrollPosition.container = {
              text: scrollPos.containerElement.text || undefined,
              resourceId: scrollPos.containerElement.resource_id || undefined,
              contentDesc: scrollPos.containerElement.content_description || undefined,
            };
          }
        }

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
    const modals = await this.repository.getNodeModals(dbNode.id);

    return {
      id: dbNode.id,
      screenName: dbNode.screen_name,
      firstSeenAt: dbNode.first_seen_at,
      lastSeenAt: dbNode.last_seen_at,
      visitCount: dbNode.visit_count,
      backStackDepth: dbNode.back_stack_depth ?? undefined,
      taskId: dbNode.task_id ?? undefined,
      modalStack: modals.length > 0
        ? modals.map((id, layer) => ({
          type: "overlay" as const,
          identifier: id,
          layer,
        }))
        : undefined,
    };
  }

  private async buildNodeResource(
    dbNode: DBNavigationNode
  ): Promise<NavigationGraphNodeResource> {
    const [node, dbEdgesFrom, dbEdgesTo] = await Promise.all([
      this.buildNodeDetail(dbNode),
      this.repository.getEdgesFrom(this.currentAppId!, dbNode.screen_name),
      this.repository.getEdgesTo(this.currentAppId!, dbNode.screen_name),
    ]);

    const [edgesFrom, edgesTo] = await Promise.all([
      this.convertDBEdgesToNavigationEdges(dbEdgesFrom),
      this.convertDBEdgesToNavigationEdges(dbEdgesTo),
    ]);

    return {
      appId: this.currentAppId,
      node,
      isCurrentScreen: this.currentScreen === dbNode.screen_name,
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
    return nodes.map(n => n.screen_name);
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

    const detail = await this.buildNodeDetail(dbNode);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, ...node } = detail;
    return node;
  }

  /**
   * Get a node resource by node ID.
   */
  public async getNodeResourceById(nodeId: number): Promise<NavigationGraphNodeResource | null> {
    if (!this.currentAppId) {
      return null;
    }

    const dbNode = await this.repository.getNodeById(this.currentAppId, nodeId);
    if (!dbNode) {
      return null;
    }

    return this.buildNodeResource(dbNode);
  }

  /**
   * Get a node resource by screen name.
   */
  public async getNodeResourceByScreen(
    screenName: string
  ): Promise<NavigationGraphNodeResource | null> {
    if (!this.currentAppId) {
      return null;
    }

    const dbNode = await this.repository.getNode(this.currentAppId, screenName);
    if (!dbNode) {
      return null;
    }

    return this.buildNodeResource(dbNode);
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
   * Get graph statistics for debugging.
   */
  public async getStats(): Promise<NavigationGraphStats> {
    return this.getStatsForApp(this.currentAppId);
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
      toolCallHistorySize: isCurrentApp ? this.toolCallHistory.length : 0,
    };
  }

  /**
   * Clear the graph for the current app.
   */
  public async clearCurrentGraph(): Promise<void> {
    if (this.currentAppId) {
      await this.repository.clearAppGraph(this.currentAppId);
      this.currentScreen = null;
      logger.info(`[NAVIGATION_GRAPH] Cleared graph for app: ${this.currentAppId}`);
      this.notifyGraphUpdated();
    }
  }

  /**
   * Clear all graphs.
   * Note: This only clears the current app's data since we use app-specific storage.
   */
  public async clearAllGraphs(): Promise<void> {
    await this.clearCurrentGraph();
    this.currentAppId = null;
    this.currentScreen = null;
    this.toolCallHistory = [];
    logger.info(`[NAVIGATION_GRAPH] Cleared all navigation graphs`);
    this.notifyGraphUpdated();
  }

  /**
   * Export the current graph for debugging/visualization.
   */
  public async exportGraph(): Promise<ExportedGraph> {
    return this.exportGraphForApp(this.currentAppId);
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
    const dbEdges = await this.repository.getEdges(appId);

    const nodes: NavigationNode[] = [];
    for (const dbNode of dbNodes) {
      const modals = await this.repository.getNodeModals(dbNode.id);
      nodes.push({
        screenName: dbNode.screen_name,
        firstSeenAt: dbNode.first_seen_at,
        lastSeenAt: dbNode.last_seen_at,
        visitCount: dbNode.visit_count,
        modalStack: modals.length > 0
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
    return apps.map(app => ({
      appId: app.app_id,
      displayName: null,
      lastUpdated: app.updated_at,
    }));
  }

  /**
   * Export a high-level graph summary for MCP resources.
   * Uses the current app if no appId is specified.
   */
  public async exportGraphSummary(): Promise<NavigationGraphSummary> {
    return this.exportGraphSummaryForApp(this.currentAppId);
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
      await this.repository.getNodeProvenanceForApp(appId)
    );
    const edgeProvenanceByEdgeId = groupEdgeProvenance(
      await this.repository.getEdgeProvenanceForApp(appId)
    );

    const nodes: NavigationGraphSummaryNode[] = dbNodes.map(node => ({
      id: node.id,
      screenName: node.screen_name,
      visitCount: node.visit_count,
      // Include screenshot path as resource URI if available
      screenshotPath: node.screenshot_path
        ? `automobile:navigation/nodes/${node.id}/screenshot`
        : null,
      provenance: nodeProvenanceByNodeId.get(node.id) ?? [],
    }));

    // Aggregate edges by (from, to, toolName) to get unique transitions with counts.
    // Track every underlying edge id per group so provenance can be unioned across
    // the multiple edge rows that collapse into a single summary transition.
    const edgeAggregation = new Map<string, { id: number; from: string; to: string; toolName: string | null; count: number; edgeIds: number[] }>();

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

    const edges: NavigationGraphSummaryEdge[] = Array.from(edgeAggregation.values()).map(agg => ({
      id: agg.id,
      from: agg.from,
      to: agg.to,
      toolName: agg.toolName,
      traversalCount: agg.count,
      provenance: mergeProvenanceRecords(
        agg.edgeIds.flatMap(edgeId => edgeProvenanceByEdgeId.get(edgeId) ?? [])
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
  public async exportGraphHistory(options: {
    cursor?: string;
    limit?: number;
  } = {}): Promise<NavigationGraphHistoryPage> {
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

    const { edges: dbEdges, hasMore } = await this.repository.getEdgesPage(
      this.currentAppId,
      {
        cursor,
        limit,
      }
    );

    const historyEdges: NavigationGraphHistoryEdge[] = dbEdges.map(edge => ({
      id: edge.id,
      from: edge.from_screen,
      to: edge.to_screen,
      toolName: edge.tool_name,
      timestamp: edge.timestamp,
    }));

    const nodeNames =
      dbEdges.length > 0
        ? new Set([dbEdges[0].from_screen, ...dbEdges.map(edge => edge.to_screen)])
        : new Set<string>();
    const dbNodes =
      nodeNames.size > 0
        ? await this.repository.getNodesByScreenNames(this.currentAppId, Array.from(nodeNames))
        : [];
    const nodeIdMap = new Map(dbNodes.map(node => [node.screen_name, node.id] as const));

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
        ...dbEdges.map(edge => ({
          id: nodeIdMap.get(edge.to_screen) ?? null,
          screenName: edge.to_screen,
          timestamp: edge.timestamp,
          edgeId: edge.id,
        }))
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

    const nextCursor =
      hasMore && dbEdges.length > 0 ? this.encodeHistoryCursor(dbEdges[dbEdges.length - 1]) : null;

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
   * Update the screenshot path for a navigation node.
   * Called after async screenshot capture completes.
   */
  public async updateNodeScreenshot(
    appId: string,
    screenName: string,
    screenshotPath: string | null
  ): Promise<void> {
    // #4931: touch navigation_apps.updated_at atomically with the screenshot write.
    // This is enrichment, not a device reach, so it records NO provenance observation
    // (observations are reach events; see #4984 decision).
    await this.repository.runInTransaction(async trx => {
      const repository = this.repository.withExecutor(trx);
      await repository.updateNodeScreenshot(appId, screenName, screenshotPath);
      await repository.touchApp(appId);
    });
    logger.debug(`[NAVIGATION_GRAPH] Updated screenshot for ${screenName}: ${screenshotPath}`);
    this.notifyGraphUpdated();
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
    return suggestions.map(s => ({
      id: s.id,
      fingerprintHash: s.fingerprint_hash,
      fingerprintData: s.fingerprint_data,
      firstSeenAt: s.first_seen_at,
      lastSeenAt: s.last_seen_at,
      occurrenceCount: s.occurrence_count,
    }));
  }

  /**
   * Promote a suggestion to a named node.
   * Creates the node if it doesn't exist and correlates the fingerprint.
   */
  public async promoteSuggestion(suggestionId: number, screenName: string): Promise<void> {
    if (!this.currentAppId) {
      throw new Error("No current app set");
    }

    const appId = this.currentAppId;
    const timestamp = this.timer.now();
    // Record the promoted node under the DEFAULT/unknown build key, NOT the current
    // (promotion-time) build/device (#4984). The suggestion's original reaches were
    // captured under whatever build saw them, but `navigation_suggestions` stores no
    // provenance, so stamping promotion-time identity would falsely claim the promoting
    // build/device did the historical reach. Recording under the default key makes the
    // promoted node visible without a false claim; transferring real suggestion
    // provenance is a follow-up (needs a suggestions-schema change).
    const provenance: ResolvedProvenance = {
      versionCode: 0,
      contentHash: "",
      deviceId: LEGACY_PROVENANCE_SENTINEL,
      sessionUuid: this.sessionUuid ?? LEGACY_PROVENANCE_SENTINEL,
    };

    // Persist the node creation + suggestion promotion atomically. repository.promoteSuggestion
    // does getOrCreateFingerprint + an UPDATE to link the suggestion; without a transaction a
    // throw after getOrCreateNode/getOrCreateFingerprint leaves an orphaned node/fingerprint with
    // the suggestion still unpromoted (partial write). Bind the whole repo to `trx` via
    // withExecutor so every statement — including the nested getOrCreateFingerprint upsert — runs
    // on the transaction; a stray singleton query would deadlock the daemon's only connection
    // (bunSqliteDialect). Only the navigation repo participates here, so no coverage enlistment /
    // shared-connection assertion is needed. Keep notifyGraphUpdated OUTSIDE so it never fires on
    // rollback and the exclusive connection is not held across it.
    await this.repository.runInTransaction(async trx => {
      const repository = this.repository.withExecutor(trx);

      // Get or create the named node
      const node = await repository.getOrCreateNode(appId, screenName, timestamp);

      // Promote the suggestion (creates fingerprint and links suggestion)
      await repository.promoteSuggestion(suggestionId, node.id, timestamp);

      // Record an observation for the promoted node under the default/unknown key
      // (see the provenance snapshot above), so it is visible in analysis rather than
      // having a visit count but no observation, without a false build/device claim.
      await this.recordNodeProvenance(repository, appId, node.id, timestamp, provenance);

      // #4931: touch navigation_apps.updated_at atomically with the promotion.
      await repository.touchApp(appId);
    });

    logger.info(
      `[NAVIGATION_GRAPH] Promoted suggestion ${suggestionId} to screen: ${screenName}`
    );

    // Post-commit side effect (never inside the transaction).
    this.notifyGraphUpdated();
  }

  /**
   * Register a listener for graph update notifications.
   * The listener can be async - it will be called without awaiting.
   * Multiple listeners can be registered; passing null removes all listeners.
   */
  public setGraphUpdateListener(listener: (() => void | Promise<void>) | null): void {
    if (listener === null) {
      this.graphUpdateListeners = [];
    } else {
      this.graphUpdateListeners.push(listener);
    }
  }

  private notifyGraphUpdated(): void {
    logger.debug(`[NAVIGATION_GRAPH] notifyGraphUpdated called, ${this.graphUpdateListeners.length} listeners`);
    for (const listener of this.graphUpdateListeners) {
      try {
        listener();
      } catch (error) {
        logger.warn(`[NAVIGATION_GRAPH] Listener error: ${error}`);
      }
    }
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
