import type { NavigationEdgeTarget } from "../../db/navigationRepository";
import { NavigationRepository } from "../../db/navigationRepository";
import { TestCoverageRepository } from "../../db/testCoverageRepository";
import type { TestCoverageSession } from "../../db/types";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  ExportedGraph,
  HierarchyNavigationEvent,
  IncomingNavigationEvent,
  NavigationAppSummary,
  NavigationEdge,
  NavigationEvent,
  NavigationGraphHistoryPage,
  NavigationGraphNodeResource,
  NavigationGraphStats,
  NavigationGraphSummary,
  NavigationNode,
  NavigationSuggestionInfo,
  NavigationToolCallHandle,
  PathResult,
  ScrollPosition,
  UIState,
} from "../../utils/interfaces/NavigationGraph";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { NavigationGraphQueries } from "./NavigationGraphQueries";
import {
  NavigationGraphRecorder,
  assertNavigationWriteCurrent,
  type NavigationRecordingState,
} from "./NavigationGraphRecorder";
import { recordNodeProvenance, type ResolvedProvenance } from "./navigationGraphWrites";
import { NavigationReplayFailures } from "./NavigationReplayFailures";
import { NavigationToolCallHistory } from "./NavigationToolCallHistory";

import type {
  NavigationBuildContext,
  NavigationBuildContextChange,
  NavigationGraphService,
  RecordedBackStack,
} from "./NavigationGraphService";

export type {
  IncomingNavigationEvent,
  NavigationBuildContext,
  NavigationBuildContextChange,
  NavigationEdge,
  NavigationEvent,
  NavigationGraphService,
  UIState,
};

/** Above SQLite's 5s busy timeout and normal loaded writes; callers only log failures, while 15s bounds a wedged tracking queue. */
const NAVIGATION_WRITE_TIMEOUT_MS = 15_000;

/** Non-null legacy sentinel used when a provenance dimension is unknown (#4984). */
export const LEGACY_PROVENANCE_SENTINEL = "legacy";

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
  // Resource notifications need the session identity; ordinary instance listeners stay unchanged.
  private static sessionGraphUpdateListener: ((sessionId: string) => void | Promise<void>) | null =
    null;
  private sessionResourceUpdateListener: (() => void | Promise<void>) | null = null;

  private readonly queries: NavigationGraphQueries;
  private readonly recorder: NavigationGraphRecorder;
  private readonly toolCalls: NavigationToolCallHistory;
  private readonly recordingState: NavigationRecordingState = {
    currentAppId: null,
    currentScreen: null,
    currentScreenConfirmed: true,
    activeNavigation: null,
    activeTestSession: null,
  };
  private repository: NavigationRepository;
  private testCoverageRepository: TestCoverageRepository;
  private timer: Timer;
  // The device whose SDK event (or applied foreground signal) last set the current app. On the
  // unattributed global manager two devices share this state, so another device's hierarchy tick
  // must not drive it, and a switch seen on one device must not retire the other's tool calls.
  private currentDeviceId: string | null = null;
  // The screen each app was on when another app came to the foreground (#10193). An SDK app
  // that returns to the foreground on the screen it was left on sends no navigation event (the
  // SDK emits only when the destination changes), so without this the manager would resume with
  // an unknown screen. In-memory on purpose: it is the same transient state as `currentScreen`.
  private lastKnownScreens: Map<string, string> = new Map();
  private static readonly LAST_KNOWN_SCREENS_CAP = 64;
  private navigationWriteState = {
    tail: Promise.resolve() as Promise<void>,
    epoch: 0,
    timeoutMs: NAVIGATION_WRITE_TIMEOUT_MS,
    /** Writes enqueued and not yet settled; a queued app switch may not have landed yet. */
    pending: 0,
  };
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
  private buildContextUpdateListener: ((change: NavigationBuildContextChange) => void) | null =
    null;

  private readonly replayFailures = new NavigationReplayFailures();

  constructor(
    repository?: NavigationRepository,
    testCoverageRepository?: TestCoverageRepository,
    timer: Timer = defaultTimer,
    sessionUuid: string | null = null,
    writeTimeoutMs: number = NAVIGATION_WRITE_TIMEOUT_MS,
  ) {
    this.repository = repository ?? new NavigationRepository();
    this.testCoverageRepository = testCoverageRepository ?? new TestCoverageRepository();
    this.timer = timer;
    this.sessionUuid = sessionUuid;
    this.navigationWriteState.timeoutMs = writeTimeoutMs;
    this.toolCalls = new NavigationToolCallHistory(this.timer, this.recordingState);
    this.recorder = new NavigationGraphRecorder(
      this.repository,
      this.testCoverageRepository,
      this.timer,
      this.recordingState,
      {
        navigationWriteState: this.navigationWriteState,
        context: {
          setCurrentApp: (appId, epoch, options) =>
            this.setCurrentAppUnlocked(appId, epoch, options),
          followDevice: (deviceId) => this.followDevice(deviceId),
          findCorrelatedToolCall: (receivedAt) => this.toolCalls.findCorrelatedToolCall(receivedAt),
          resolveProvenance: (appId) => this.resolveProvenance(appId),
          retireToolCalls: (matches) => this.toolCalls.retireToolCalls(matches),
          notifyGraphUpdated: () => this.notifyGraphUpdated(),
          forgetFailedEdgeReplay: (pairKey, actionKey) =>
            this.replayFailures.forgetFailedEdgeReplay(pairKey, actionKey),
        },
      },
    );
    this.queries = new NavigationGraphQueries(this.repository, {
      getCurrentAppId: () => this.recordingState.currentAppId,
      getCurrentScreen: () => this.recordingState.currentScreen,
      getToolCallHistorySize: () => this.toolCalls.size,
      isEdgeReplayFailed: (appId, edge) => this.replayFailures.isEdgeReplayFailed(appId, edge),
    });
  }

  /**
   * Set the build/device provenance context for `context.appId` (#4984). Called by
   * the CtrlProxy client that owns the device; the content hash is resolved eagerly
   * (and cached) at bind time so nav events that arrive later record under the real
   * build key. Stored per app so switching apps never applies one app's context to
   * another.
   */
  public setBuildContext(context: NavigationBuildContext): void {
    const previous = this.buildContexts.get(context.appId);
    if (
      previous?.deviceId === context.deviceId &&
      previous.versionCode === context.versionCode &&
      previous.versionKey === context.versionKey &&
      previous.contentHash === context.contentHash
    ) {
      return;
    }
    this.buildContexts.set(context.appId, { ...context });
    this.notifyBuildContextUpdate({
      appId: context.appId,
      deviceId: context.deviceId,
      buildContext: { ...context },
    });
  }

  /**
   * Drop the build context for an app (#4984), so its next mutation falls to the
   * default key until re-resolved. Called on a package update/reinstall/removal.
   */
  public clearBuildContext(appId: string): void {
    const previous = this.buildContexts.get(appId);
    if (previous) {
      this.buildContexts.delete(appId);
      this.notifyBuildContextUpdate({ appId, deviceId: previous.deviceId, buildContext: null });
    }
  }

  public getBuildContexts(): NavigationBuildContext[] {
    return [...this.buildContexts.values()].map((context) => ({ ...context }));
  }

  public setBuildContextUpdateListener(
    listener: ((change: NavigationBuildContextChange) => void) | null,
  ): void {
    this.buildContextUpdateListener = listener;
  }

  private notifyBuildContextUpdate(change: NavigationBuildContextChange): boolean {
    try {
      this.buildContextUpdateListener?.(change);
      return true;
    } catch (error) {
      // Stream delivery is best-effort; a listener failure must not discard provenance.
      logger.warn("[NAVIGATION_GRAPH] Build-context listener failed", error);
      return false;
    }
  }

  /**
   * Resolve the serial/UDID that owns an app's navigation graph, from the app's
   * build context (epic #5256, item 3). The daemon uses this to attribute a
   * graph-update push to a device so panes watching other devices are not
   * cross-contaminated (closes #4837). Returns `null` when the app has no build
   * context or only the legacy sentinel — in which case the daemon broadcasts to
   * all-device subscribers rather than mis-attributing.
   */
  public getDeviceIdForApp(appId: string | null): string | null {
    if (!appId) {
      return null;
    }
    const deviceId = this.buildContexts.get(appId)?.deviceId;
    if (!deviceId || deviceId === LEGACY_PROVENANCE_SENTINEL) {
      return null;
    }
    return deviceId;
  }

  /**
   * Get the singleton instance of NavigationGraphManager.
   * Used for non-daemon single-agent mode.
   */
  public static getInstance(): NavigationGraphService {
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
  public static getInstanceForSession(sessionId: string): NavigationGraphService {
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
      // Attach the resource-layer notify callback so session-scoped writes refresh
      // the navigation resources, not only writes on the global instance (#4932).
      NavigationGraphManager.attachSessionGraphUpdateListener(sessionId, instance);
      NavigationGraphManager.sessionInstances.set(sessionId, instance);
    }
    return instance;
  }

  /**
   * The manager this session already has, without minting one and without the released-session
   * fallback to the global manager (#10825).
   */
  public static findInstanceForSession(sessionId: string): NavigationGraphManager | undefined {
    return NavigationGraphManager.sessionInstances.get(sessionId);
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

  /** Clear a live session's device-scoped navigation state without tombstoning it. */
  public static resetSession(sessionId: string): void {
    const instance = NavigationGraphManager.sessionInstances.get(sessionId);
    if (instance) {
      instance.recordingState.activeTestSession = null;
      instance.toolCalls.clear();
      instance.recordingState.activeNavigation = null;
      instance.graphUpdateListeners = [];
      NavigationGraphManager.sessionInstances.delete(sessionId);
      logger.debug(`[NAV_GRAPH] Reset session instance: ${sessionId}`);
    }
  }

  /**
   * Release a session-scoped instance and its transient state.
   */
  public static releaseSession(sessionId: string): void {
    NavigationGraphManager.resetSession(sessionId);
    // Mark released even if no instance existed yet, so a later stray event for this
    // session resolves to the unattributed global rather than minting a manager for
    // the ended session (#4984). Bounded FIFO to cap long-daemon growth.
    NavigationGraphManager.releasedSessions.add(sessionId);
    if (
      NavigationGraphManager.releasedSessions.size > NavigationGraphManager.RELEASED_SESSIONS_CAP
    ) {
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
    // Clear the process-wide session listener too, so a listener registered by one
    // test (or the daemon) never leaks into a sibling suite in the same process.
    NavigationGraphManager.sessionGraphUpdateListener = null;
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
    instance: NavigationGraphManager,
  ): void {
    // Installing an instance clears any released-mark so the id resolves to it.
    NavigationGraphManager.releasedSessions.delete(sessionId);
    NavigationGraphManager.sessionInstances.set(sessionId, instance);
    NavigationGraphManager.attachSessionGraphUpdateListener(sessionId, instance);
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
    sessionUuid?: string,
    writeTimeoutMs?: number,
  ): NavigationGraphManager {
    return new NavigationGraphManager(
      repository,
      testCoverageRepository,
      timer,
      sessionUuid ?? null,
      writeTimeoutMs,
    );
  }

  /**
   * Start a test coverage session.
   * This enables tracking which nodes and edges are visited during tests.
   */
  public async startTestSession(sessionUuid: string): Promise<void> {
    if (!this.recordingState.currentAppId) {
      logger.warn(`[TEST_COVERAGE] Cannot start test session - no current app set`);
      return;
    }

    this.recordingState.activeTestSession = await this.testCoverageRepository.getOrCreateSession(
      sessionUuid,
      this.recordingState.currentAppId,
    );

    logger.info(
      `[TEST_COVERAGE] Started test session: ${sessionUuid} for app: ${this.recordingState.currentAppId}`,
    );
  }

  /**
   * End the current test coverage session.
   */
  public async endTestSession(): Promise<void> {
    if (!this.recordingState.activeTestSession) {
      return;
    }

    await this.testCoverageRepository.endSession(
      this.recordingState.activeTestSession.session_uuid,
    );
    logger.info(
      `[TEST_COVERAGE] Ended test session: ${this.recordingState.activeTestSession.session_uuid}`,
    );
    this.recordingState.activeTestSession = null;
  }

  /**
   * Get the active test coverage session (if any).
   */
  public getActiveTestSession(): TestCoverageSession | null {
    return this.recordingState.activeTestSession;
  }

  /**
   * Set the current app being navigated.
   * Creates the app record in the database if it doesn't exist.
   */
  public async setCurrentApp(appId: string): Promise<void> {
    // An explicit switch proves nothing about the screen, so it is left unknown (#10193).
    return this.enqueueNavigationWrite("setCurrentApp", async (epoch) => {
      await this.setCurrentAppUnlocked(appId, epoch, { restoreScreen: false });
    });
  }

  private enqueueNavigationWrite<T>(
    operation: string,
    write: (epoch: number) => Promise<T>,
  ): Promise<T> {
    this.navigationWriteState.pending++;
    const result = this.navigationWriteState.tail.then(() => {
      const epoch = this.navigationWriteState.epoch;
      return raceWithDeadline(() => write(epoch), {
        timer: this.timer,
        timeoutMs: this.navigationWriteState.timeoutMs,
        unref: true,
        label: `Navigation write ${operation}`,
        onTimeout: () => {
          this.navigationWriteState.epoch++;
          logger.warn(
            `[NAVIGATION_GRAPH] Navigation write ${operation} timed out after ${this.navigationWriteState.timeoutMs}ms`,
          );
        },
      });
    });
    // Keep the tail usable after failure; return result so this caller still sees its rejection.
    this.navigationWriteState.tail = result.then(
      () => {
        this.navigationWriteState.pending--;
      },
      () => {
        this.navigationWriteState.pending--;
      },
    );
    return result;
  }

  /**
   * Switch the current app. Returns whether the app changed.
   *
   * `restoreScreen` puts back the screen the incoming app was last left on (#10193). It is only
   * safe where the app itself reported its identity (an SDK navigation event, or a foreground
   * signal for an SDK app): a hierarchy-driven or explicit switch leaves the screen unknown
   * (the hierarchy fingerprint may still name it) rather than guess.
   *
   * `observedAt` is when the triggering event was received; tool calls recorded before it were
   * issued while another app owned the screen, so they can no longer label a transition.
   */
  private async setCurrentAppUnlocked(
    appId: string,
    epoch: number,
    options: { restoreScreen: boolean; observedAt?: number; deviceId?: string },
  ): Promise<boolean> {
    if (this.recordingState.currentAppId === appId) {
      return false;
    }

    // Ensure the app row exists BEFORE committing the in-memory switch (#9992). A rejected
    // insert (busy/locked shared DB) must leave the manager on its previous app so the next
    // event retries; assigning first left currentAppId pointing at an app with no row, and every
    // later event hit the navigation_nodes.app_id foreign key. The error propagates to the caller.
    await this.repository.getOrCreateApp(appId);
    assertNavigationWriteCurrent(epoch, this.navigationWriteState);
    const switchedFromApp = this.recordingState.currentAppId !== null;
    // Another device's signal moves the manager to that device; it is not an app switch on the
    // device the tool calls were made on, so it retires none of them.
    const sameDevice = !this.isOtherDevice(options.deviceId);
    this.rememberCurrentScreen();
    this.recordingState.currentAppId = appId;
    this.recordingState.currentScreen = options.restoreScreen
      ? (this.lastKnownScreens.get(appId) ?? null)
      : null;
    // A restored screen is only a hint (#10193 review); an unknown one has nothing to confirm.
    this.recordingState.currentScreenConfirmed = !this.recordingState.currentScreen;
    this.recordingState.activeNavigation = null;
    if (switchedFromApp && options.observedAt !== undefined && sameDevice) {
      this.dropToolCallsRecordedThrough(options.observedAt, options.deviceId);
    }
    this.followDevice(options.deviceId);
    logger.info(
      `[NAVIGATION_GRAPH] Set current app: ${appId}` +
        (this.recordingState.currentScreen
          ? ` (resumed on ${this.recordingState.currentScreen})`
          : ""),
    );
    this.notifyGraphUpdated();
    return true;
  }

  private rememberCurrentScreen(): void {
    if (!this.recordingState.currentAppId) {
      return;
    }
    this.lastKnownScreens.delete(this.recordingState.currentAppId);
    if (!this.recordingState.currentScreen) {
      return;
    }
    this.lastKnownScreens.set(this.recordingState.currentAppId, this.recordingState.currentScreen);
    if (this.lastKnownScreens.size > NavigationGraphManager.LAST_KNOWN_SCREENS_CAP) {
      const oldest = this.lastKnownScreens.keys().next().value;
      this.lastKnownScreens.delete(oldest ?? "");
    }
  }

  /**
   * An SDK app is back in front. The SDK sends no navigation event when it resumes on the
   * screen it was left on and the client skips hierarchy updates for SDK apps, so this is the
   * only signal that brings back the remembered screen (#10193). Cheap when nothing changed.
   */
  public async recordAppForeground(appId: string, deviceId?: string): Promise<void> {
    const trimmed = appId.trim();
    if (!trimmed || this.isOtherDevice(deviceId)) {
      return;
    }
    // A queued app switch may not have landed, so only a quiet queue proves nothing changed.
    if (trimmed === this.recordingState.currentAppId && this.navigationWriteState.pending === 0) {
      this.followDevice(deviceId);
      return;
    }
    const observedAt = this.timer.now();
    await this.enqueueNavigationWrite("recordAppForeground", async (epoch) => {
      // Re-checked where the queued write runs: an SDK event from the other device may have
      // landed first, and the manager then follows that device, not this one.
      if (this.isOtherDevice(deviceId)) {
        return false;
      }
      const switched = await this.setCurrentAppUnlocked(trimmed, epoch, {
        restoreScreen: true,
        observedAt,
        deviceId,
      });
      this.followDevice(deviceId);
      return switched;
    });
  }

  /** A signal from a device other than the one whose app is current (unknown devices match). */
  private isOtherDevice(deviceId: string | undefined): boolean {
    return (
      deviceId !== undefined && this.currentDeviceId !== null && deviceId !== this.currentDeviceId
    );
  }

  private followDevice(deviceId: string | undefined): void {
    if (deviceId !== undefined) {
      this.currentDeviceId = deviceId;
    }
  }

  /**
   * Forget where an app was, because its process is known to have stopped or been reset
   * (terminate, crash, uninstall, cold launch, cleared data): a fresh process must not get an
   * edge from a stale screen (#10193). Synchronous and idempotent.
   */
  public forgetAppScreen(appId: string): void {
    this.lastKnownScreens.delete(appId);
    if (this.recordingState.currentAppId === appId) {
      this.recordingState.currentScreen = null;
      this.recordingState.activeNavigation = null;
    }
  }

  /**
   * Forget every remembered screen, for a tool that replaces processes without naming the app
   * (an `installApp` of an artifact, a device kill): which app died is unknown, and a lost hint
   * only leaves the screen unknown until the next event, while a stale one writes a bogus edge.
   */
  public forgetAllAppScreens(): void {
    this.lastKnownScreens.clear();
    this.recordingState.currentScreen = null;
    this.recordingState.activeNavigation = null;
  }

  /** Retire calls recorded up to `observedAt`; with a device, only that device's (or unattributed) calls. */
  private dropToolCallsRecordedThrough(observedAt: number, deviceId?: string): void {
    this.toolCalls.retireToolCalls(
      (tc) =>
        tc.timestamp <= observedAt &&
        (deviceId === undefined || tc.deviceId === undefined || tc.deviceId === deviceId),
    );
  }

  /**
   * Get the current app ID.
   */
  public getCurrentAppId(): string | null {
    return this.recordingState.currentAppId;
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
        `recording provenance under the default build key`,
    );
    return { versionCode: 0, contentHash: "", deviceId: LEGACY_PROVENANCE_SENTINEL, sessionUuid };
  }

  /**
   * Record back stack information for the current screen.
   * Updates the current node with back stack depth and task ID.
   */
  public async recordBackStack(backStack: RecordedBackStack): Promise<void> {
    if (!this.recordingState.currentAppId || !this.recordingState.currentScreen) {
      logger.debug(`[NAVIGATION_GRAPH] Cannot record back stack - no current app or screen`);
      return;
    }
    if (!this.recordingState.currentScreenConfirmed) {
      // The depth belongs to whatever is on screen, which a restored hint may not be.
      logger.debug(
        `[NAVIGATION_GRAPH] Not recording back stack on unconfirmed ${this.recordingState.currentScreen}`,
      );
      return;
    }

    const appId = this.recordingState.currentAppId;
    const screenName = this.recordingState.currentScreen;

    // Persist the back-stack update + app touch atomically (#4931): both run on the
    // transaction-bound repository so a throw rolls back together and the exclusive
    // connection is never held across non-DB work.
    await this.repository.runInTransaction(async (trx) => {
      const repository = this.repository.withExecutor(trx);
      await repository.updateNodeBackStack(
        appId,
        screenName,
        backStack.depth,
        backStack.currentTaskId,
      );
      await repository.touchApp(appId);
    });

    logger.debug(
      `[NAVIGATION_GRAPH] Updated back stack for ${screenName}: ` +
        `depth=${backStack.depth}, taskId=${backStack.currentTaskId}`,
    );
  }

  /**
   * Record a navigation event from WebSocket.
   * If the event contains an applicationId, automatically sets/switches the current app.
   * This creates a "named node" in the navigation graph.
   */
  public async recordNavigationEvent(event: IncomingNavigationEvent): Promise<void> {
    // Capture receipt before any async app switch or DB work. Tool calls use this
    // same host clock; the SDK timestamp remains the graph's persisted event time.
    const receivedAt = this.timer.now();
    return this.enqueueNavigationWrite("recordNavigationEvent", (epoch) =>
      this.recorder.recordNavigationEventUnlocked(event, receivedAt, epoch),
    );
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
    const receivedAt = this.timer.now();
    return this.enqueueNavigationWrite("recordHierarchyNavigation", (epoch) =>
      this.recorder.recordHierarchyNavigationUnlocked(event, receivedAt, epoch),
    );
  }
  public recordToolCall(
    toolName: string,
    args: Record<string, any>,
    uiState?: UIState,
    deviceId?: string,
  ): NavigationToolCallHandle {
    return this.toolCalls.recordToolCall(toolName, args, uiState, deviceId);
  }
  public updateScrollPosition(scrollPosition: ScrollPosition): void {
    return this.toolCalls.updateScrollPosition(scrollPosition);
  }

  /**
   * Get the current screen name (runtime state).
   */
  public getCurrentScreen(): string | null {
    return this.recordingState.currentScreen;
  }
  public async findPath(targetScreen: string): Promise<PathResult> {
    return this.queries.findPath(targetScreen);
  }

  /**
   * Remember whether replaying `edge` reached its target (#10031). A failure ranks
   * that edge's action below every edge not known to fail for the same screen pair in
   * later findPath calls (it stays a last resort rather than disappearing); a success
   * forgets the failure. Edges with no tool call (replayed as Back) are tracked too.
   */
  public recordEdgeReplayOutcome(edge: NavigationEdge, reached: boolean): void {
    this.replayFailures.recordEdgeReplayOutcome(this.recordingState.currentAppId, edge, reached);
  }

  public hasEdgeReplayFailure(edge: NavigationEdge): boolean {
    return this.replayFailures.hasEdgeReplayFailure(this.recordingState.currentAppId, edge);
  }

  public settleTransientEdgeFailure(edge: NavigationEdge, searched: boolean): void {
    this.replayFailures.settleTransientEdgeFailure(
      this.recordingState.currentAppId,
      edge,
      searched,
    );
  }

  public async getKnownScreens(): Promise<string[]> {
    return this.queries.getKnownScreens();
  }
  public async getNode(screenName: string): Promise<NavigationNode | undefined> {
    return this.queries.getNode(screenName);
  }
  public async getNodeResourceById(
    nodeId: number,
    appId?: string,
  ): Promise<NavigationGraphNodeResource | null> {
    return this.queries.getNodeResourceById(nodeId, appId);
  }
  public async getNodeResourceByScreen(
    screenName: string,
  ): Promise<NavigationGraphNodeResource | null> {
    return this.queries.getNodeResourceByScreen(screenName);
  }
  public async getEdgesFrom(screenName: string): Promise<NavigationEdge[]> {
    return this.queries.getEdgesFrom(screenName);
  }
  public async getEdgeTargetsFrom(screenName: string): Promise<NavigationEdgeTarget[]> {
    return this.queries.getEdgeTargetsFrom(screenName);
  }
  public async getEdgesTo(screenName: string): Promise<NavigationEdge[]> {
    return this.queries.getEdgesTo(screenName);
  }
  public async getStats(): Promise<NavigationGraphStats> {
    return this.getStatsForApp(this.recordingState.currentAppId);
  }
  public async getStatsForApp(appId: string | null): Promise<NavigationGraphStats> {
    return this.queries.getStatsForApp(appId);
  }

  /**
   * Clear the graph for the current app.
   */
  public async clearCurrentGraph(): Promise<void> {
    return this.enqueueNavigationWrite("clearCurrentGraph", (epoch) =>
      this.clearCurrentGraphUnlocked(epoch),
    );
  }

  private async clearCurrentGraphUnlocked(epoch: number): Promise<void> {
    const appId = this.recordingState.currentAppId;
    if (appId) {
      await this.repository.clearAppGraph(appId);
      // The node ids held by the SDK-correlation window were just deleted; drop it
      // before the epoch check so a superseded clear cannot leave a fingerprint write
      // (correlateActiveNavigation) targeting a dead node (FK violation).
      if (this.recordingState.activeNavigation?.appId === appId) {
        this.recordingState.activeNavigation = null;
      }
      assertNavigationWriteCurrent(epoch, this.navigationWriteState);
      this.recordingState.currentScreen = null;
      this.lastKnownScreens.delete(appId);
      this.replayFailures.clear();
      logger.info(`[NAVIGATION_GRAPH] Cleared graph for app: ${appId}`);
      this.notifyGraphUpdated();
    }
  }

  /**
   * Clear all graphs.
   * Note: This only clears the current app's data since we use app-specific storage.
   */
  public async clearAllGraphs(): Promise<void> {
    return this.enqueueNavigationWrite("clearAllGraphs", async (epoch) => {
      await this.clearCurrentGraphUnlocked(epoch);
      assertNavigationWriteCurrent(epoch, this.navigationWriteState);
      this.recordingState.currentAppId = null;
      this.recordingState.currentScreen = null;
      this.lastKnownScreens.clear();
      this.recordingState.activeNavigation = null;
      this.toolCalls.clear();
      logger.info(`[NAVIGATION_GRAPH] Cleared all navigation graphs`);
      this.notifyGraphUpdated();
    });
  }
  public async exportGraph(): Promise<ExportedGraph> {
    return this.exportGraphForApp(this.recordingState.currentAppId);
  }
  public async exportGraphForApp(appId: string | null): Promise<ExportedGraph> {
    return this.queries.exportGraphForApp(appId);
  }
  public async listAppsWithGraph(): Promise<NavigationAppSummary[]> {
    return this.queries.listAppsWithGraph();
  }
  public async exportGraphSummary(): Promise<NavigationGraphSummary> {
    return this.exportGraphSummaryForApp(this.recordingState.currentAppId);
  }
  public async exportGraphSummaryForApp(appId: string | null): Promise<NavigationGraphSummary> {
    return this.queries.exportGraphSummaryForApp(appId);
  }
  public async exportGraphHistory(
    options: {
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<NavigationGraphHistoryPage> {
    return this.queries.exportGraphHistory(options);
  }

  /**
   * Update the screenshot path for a navigation node.
   * Called after async screenshot capture completes.
   */
  public async updateNodeScreenshot(
    appId: string,
    screenName: string,
    screenshotPath: string | null,
  ): Promise<void> {
    // #4931: touch navigation_apps.updated_at atomically with the screenshot write.
    // This is enrichment, not a device reach, so it records NO provenance observation
    // (observations are reach events; see #4984 decision).
    await this.repository.runInTransaction(async (trx) => {
      const repository = this.repository.withExecutor(trx);
      await repository.updateNodeScreenshot(appId, screenName, screenshotPath);
      await repository.touchApp(appId);
    });
    logger.debug(`[NAVIGATION_GRAPH] Updated screenshot for ${screenName}: ${screenshotPath}`);
    this.notifyGraphUpdated();
  }
  public async getSuggestions(): Promise<NavigationSuggestionInfo[]> {
    return this.queries.getSuggestions();
  }

  /**
   * Promote a suggestion to a named node.
   * Creates the node if it doesn't exist and correlates the fingerprint.
   */
  public async promoteSuggestion(suggestionId: number, screenName: string): Promise<void> {
    if (!this.recordingState.currentAppId) {
      throw new Error("No current app set");
    }

    const appId = this.recordingState.currentAppId;
    const timestamp = this.timer.now();
    // Old suggestions have no observations. Their original build/device is
    // unknowable, so only those use the default/unknown identity on promotion.
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
    await this.repository.runInTransaction(async (trx) => {
      const repository = this.repository.withExecutor(trx);

      // Get or create the named node
      const node = await repository.getOrCreateNode(appId, screenName, timestamp);

      // Promote the suggestion (creates fingerprint and links suggestion)
      const fingerprint = await repository.promoteSuggestion(suggestionId, node.id, timestamp);

      // A suggestion from another app cannot lend its build keys to this node.
      const transferred =
        fingerprint.app_id === appId &&
        (await repository.transferSuggestionObservations(suggestionId, node.id));
      if (!transferred) {
        await recordNodeProvenance(repository, appId, node.id, timestamp, provenance);
      }

      // #4931: touch navigation_apps.updated_at atomically with the promotion.
      await repository.touchApp(appId);
    });

    logger.info(`[NAVIGATION_GRAPH] Promoted suggestion ${suggestionId} to screen: ${screenName}`);

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
    } else if (!this.graphUpdateListeners.includes(listener)) {
      // Idempotent add: a subsystem re-registering the same callback (e.g. the
      // resource layer re-attaching on provider swap) must not double-notify.
      this.graphUpdateListeners.push(listener);
    }
  }

  /** Remove exactly one listener, leaving other subsystems' listeners attached. */
  public removeGraphUpdateListener(listener: () => void | Promise<void>): void {
    this.graphUpdateListeners = this.graphUpdateListeners.filter((entry) => entry !== listener);
  }

  /** Register resource updates for existing and future session managers without replacing other listeners. */
  public static setSessionGraphUpdateListener(
    listener: ((sessionId: string) => void | Promise<void>) | null,
  ): void {
    NavigationGraphManager.sessionGraphUpdateListener = listener;
    for (const [sessionId, instance] of NavigationGraphManager.sessionInstances) {
      NavigationGraphManager.attachSessionGraphUpdateListener(sessionId, instance);
    }
  }

  private static attachSessionGraphUpdateListener(
    sessionId: string,
    instance: NavigationGraphManager,
  ): void {
    if (instance.sessionResourceUpdateListener) {
      instance.removeGraphUpdateListener(instance.sessionResourceUpdateListener);
    }
    const listener = NavigationGraphManager.sessionGraphUpdateListener;
    instance.sessionResourceUpdateListener = listener ? () => listener(sessionId) : null;
    if (instance.sessionResourceUpdateListener) {
      instance.setGraphUpdateListener(instance.sessionResourceUpdateListener);
    }
  }

  private notifyGraphUpdated(): void {
    logger.debug(
      `[NAVIGATION_GRAPH] notifyGraphUpdated called, ${this.graphUpdateListeners.length} listeners`,
    );
    for (const listener of this.graphUpdateListeners) {
      try {
        Promise.resolve(listener()).catch((error) => {
          logger.warn(`[NAVIGATION_GRAPH] Listener error: ${errorMessage(error)}`, error);
        });
      } catch (error) {
        logger.warn(`[NAVIGATION_GRAPH] Listener error: ${errorMessage(error)}`, error);
      }
    }
  }
}
