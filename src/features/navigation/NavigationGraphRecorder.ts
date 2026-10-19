import { edgeActionKey, edgePairKey } from "../../db/edgeReplayKey";
import { NavigationRepository } from "../../db/navigationRepository";
import { TestCoverageRepository } from "../../db/testCoverageRepository";
import type { TestCoverageSession } from "../../db/types";
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  HierarchyNavigationEvent,
  IncomingNavigationEvent,
  ToolCallInteraction,
} from "../../utils/interfaces/NavigationGraph";
import { logger } from "../../utils/logger";
import { buildNavigationNodeScreenshotUri } from "../../utils/navigationResourceUri";
import { Timer } from "../../utils/SystemTimer";
import { TelemetryRecorder } from "../telemetry/TelemetryRecorder";
import {
  recordEdgeProvenance,
  recordNodeProvenance,
  storeScrollPosition,
  storeUIElements,
  type ResolvedProvenance,
} from "./navigationGraphWrites";

export function assertNavigationWriteCurrent(epoch: number, state: { epoch: number }): void {
  if (epoch !== state.epoch) {
    throw new ActionableError("Navigation write was superseded after its deadline");
  }
}

/** What one recorded screen transition writes, shared by the node and edge persistence steps. */
interface ScreenTransitionWrite {
  appId: string;
  screenName: string;
  timestamp: number;
  provenance: ResolvedProvenance;
  modalStack: NonNullable<ToolCallInteraction["uiState"]>["modalStack"] | undefined;
  interaction: ToolCallInteraction | undefined;
}
export interface NavigationRecordingState {
  currentAppId: string | null;
  currentScreen: string | null;
  // A screen restored from lastKnownScreens is a hint until an SDK event or fingerprint
  // confirms it. Hints support warm-return navigation but must never start an edge (#10193).
  currentScreenConfirmed: boolean;
  activeTestSession: TestCoverageSession | null;
  /** App-scoped SDK navigation awaiting a fingerprint within the correlation window. */
  activeNavigation: {
    appId: string;
    nodeId: number;
    screenName: string;
    startTime: number;
  } | null;
}
interface NavigationRecordingContext {
  setCurrentApp(
    appId: string,
    epoch: number,
    options: { restoreScreen: boolean; observedAt?: number; deviceId?: string },
  ): Promise<boolean>;
  followDevice(deviceId: string | undefined): void;
  findCorrelatedToolCall(receivedAt: number): ToolCallInteraction | undefined;
  resolveProvenance(appId: string | null): ResolvedProvenance;
  retireToolCalls(matches: (toolCall: ToolCallInteraction) => boolean): void;
  notifyGraphUpdated(): void;
  forgetFailedEdgeReplay(pairKey: string, actionKey: string): void;
}
/** Atomic graph recording and post-commit effects, invoked only through the manager's write queue. */
export class NavigationGraphRecorder {
  private readonly ACTIVE_NAVIGATION_WINDOW_MS = 1000;
  constructor(
    private readonly repository: NavigationRepository,
    private readonly testCoverageRepository: TestCoverageRepository,
    private readonly timer: Timer,
    private readonly state: NavigationRecordingState,
    private readonly navigationWriteState: { epoch: number },
    private readonly context: NavigationRecordingContext,
  ) {}

  public async recordNavigationEventUnlocked(
    event: IncomingNavigationEvent,
    receivedAt: number,
    epoch: number,
  ): Promise<void> {
    // Auto-set current app from navigation event if provided. A switch here drops the tool
    // calls recorded before the event: they were issued while another app was in front, so
    // they cannot be what moved this app (#10193).
    if (event.applicationId && event.applicationId !== this.state.currentAppId) {
      await this.context.setCurrentApp(event.applicationId, epoch, {
        restoreScreen: true,
        observedAt: receivedAt,
        deviceId: event.deviceId,
      });
    }

    assertNavigationWriteCurrent(epoch, this.navigationWriteState);
    this.context.followDevice(event.deviceId);

    if (!this.state.currentAppId) {
      logger.warn(`[NAVIGATION_GRAPH] Cannot record event - no current app set`);
      return;
    }

    const appId = this.state.currentAppId;
    const screenName = event.destination;
    const timestamp = event.timestamp ?? this.timer.now();

    // Capture the previous screen up front. The edge is computed from it and the
    // in-memory field assignments below only happen AFTER the transaction commits,
    // so on rollback `this.currentScreen` stays the previous screen and the next
    // event still computes the correct edge.
    const { screen: previousScreen, unconfirmed: sourceUnconfirmed } = this.edgeSource();

    // Get modal stack from the most recent tool call (if any)
    const recentToolCall = this.context.findCorrelatedToolCall(receivedAt);
    // The call this event consumes. An event that confirms a restored hint writes no edge, but it
    // is still the navigation the call caused: consume it so it cannot label the next one.
    let edgeInteraction: ToolCallInteraction | undefined = sourceUnconfirmed
      ? recentToolCall
      : undefined;
    const currentModalStack = recentToolCall?.uiState?.modalStack;

    // Snapshot provenance ONCE for this transition so the node and edge observations
    // share one build key even if a fire-and-forget hash lands mid-transaction (#4984).
    const provenance = this.context.resolveProvenance(appId);

    // Persist the whole graph write atomically across BOTH repos via the shared helper,
    // which owns the assertSharedConnection() precondition and the bind-both-repos
    // preamble (#3075). Every read and write inside the callback runs on the transaction
    // (via withExecutor) — a stray singleton query here would deadlock the daemon's only
    // connection (bunSqliteDialect). Keep the body to DB statements only: telemetry push,
    // notifications, screenshot capture and in-memory field assignments stay OUTSIDE so
    // the exclusive connection is not held across non-DB IO, and so they never run when
    // the transaction rolls back.
    const transition: ScreenTransitionWrite = {
      appId,
      screenName,
      timestamp,
      provenance,
      modalStack: currentModalStack,
      interaction: recentToolCall,
    };
    const node = await this.runBothReposInTransaction(
      async (repository, testCoverageRepository) => {
        const n = await this.persistTransitionNode(repository, testCoverageRepository, transition);

        // Create edge from previous screen to current screen
        if (previousScreen && previousScreen !== screenName) {
          edgeInteraction = recentToolCall;
          await this.persistTransitionEdge(
            repository,
            testCoverageRepository,
            transition,
            previousScreen,
          );
        }

        await repository.touchApp(appId);
        return n;
      },
    );

    assertNavigationWriteCurrent(epoch, this.navigationWriteState);

    // ---- Post-commit side effects (never inside the transaction) ----

    // Consume only a committed transition's match, not initial/same-screen events.
    // A rolled-back write leaves the call eligible for the next edge.
    this.context.retireToolCalls((tc) => tc === edgeInteraction);

    // Set active navigation state for fingerprint correlation. Fingerprints seen
    // within ACTIVE_NAVIGATION_WINDOW_MS in the same app will be correlated to this node.
    this.state.activeNavigation = {
      appId,
      nodeId: node.id,
      screenName: screenName,
      startTime: timestamp,
    };

    this.state.currentScreen = screenName;
    this.state.currentScreenConfirmed = true;
    this.context.notifyGraphUpdated();

    this.pushNavigationTelemetry(event, { appId, nodeId: node.id, screenName, timestamp });
  }

  private async persistTransitionNode(
    repository: NavigationRepository,
    testCoverageRepository: TestCoverageRepository,
    transition: ScreenTransitionWrite,
  ) {
    const { appId, screenName, timestamp, provenance, modalStack } = transition;
    // Get or create node and update visit count
    const n = await repository.getOrCreateNode(appId, screenName, timestamp);

    // Record per-node provenance for the current build/device/session (#4984),
    // in the same transaction as the node mutation.
    await recordNodeProvenance(repository, appId, n.id, timestamp, provenance);

    // Record node visit for test coverage if session is active
    if (this.state.activeTestSession) {
      await testCoverageRepository.recordNodeVisit(
        this.state.activeTestSession.id,
        n.id,
        timestamp,
      );
    }

    // Update node modals if present
    if (modalStack && modalStack.length > 0) {
      const modalIds = modalStack.map((m) => m.identifier || `${m.type}-${m.layer}`);
      await repository.setNodeModals(n.id, modalIds);

      logger.info(`[NAVIGATION_GRAPH] Screen ${screenName} has ${modalIds.length} modal(s)`);
    }
    return n;
  }

  private async persistTransitionEdge(
    repository: NavigationRepository,
    testCoverageRepository: TestCoverageRepository,
    transition: ScreenTransitionWrite,
    previousScreen: string,
  ): Promise<void> {
    const { appId, screenName, timestamp, provenance, interaction } = transition;
    const toolName = interaction?.toolName || null;
    const toolArgs = interaction?.args || null;

    const edge = await repository.createEdge(
      appId,
      previousScreen,
      screenName,
      toolName,
      toolArgs,
      timestamp,
    );
    // The action just led from this screen to that one, so a remembered replay
    // failure for it is stale.
    this.context.forgetFailedEdgeReplay(
      edgePairKey(appId, previousScreen, screenName),
      edgeActionKey(toolName, toolArgs ?? undefined),
    );

    // Record per-edge provenance using the SAME snapshot as the node (#4984).
    await recordEdgeProvenance(repository, appId, edge.id, timestamp, provenance);

    // Record edge traversal for test coverage if session is active
    if (this.state.activeTestSession) {
      await testCoverageRepository.recordEdgeTraversal(
        this.state.activeTestSession.id,
        edge.id,
        timestamp,
      );
    }
    await this.persistEdgeContext(repository, edge.id, transition, previousScreen);
  }

  /** Elements, from/to modal stacks and scroll position carried by the edge's interaction. */
  private async persistEdgeContext(
    repository: NavigationRepository,
    edgeId: number,
    transition: ScreenTransitionWrite,
    previousScreen: string,
  ): Promise<void> {
    const { appId, timestamp, modalStack, interaction } = transition;
    // Store UI elements if present in interaction
    if (interaction?.uiState?.selectedElements) {
      await storeUIElements(
        repository,
        this.state.currentAppId,
        edgeId,
        interaction.uiState.selectedElements,
        timestamp,
      );
    }

    // Store modal stacks for from/to
    const fromNode = await repository.getNode(appId, previousScreen);
    if (fromNode) {
      const fromModals = await repository.getNodeModals(fromNode.id);
      if (fromModals.length > 0) {
        await repository.setEdgeModals(edgeId, "from", fromModals);
      }
    }

    if (modalStack && modalStack.length > 0) {
      const toModalIds = modalStack.map((m) => m.identifier || `${m.type}-${m.layer}`);
      await repository.setEdgeModals(edgeId, "to", toModalIds);
    }

    // Store scroll position if present
    if (interaction?.uiState?.scrollPosition) {
      await storeScrollPosition(
        repository,
        this.state.currentAppId,
        edgeId,
        interaction.uiState.scrollPosition,
        timestamp,
      );
    }
  }

  /**
   * Push to the telemetry dashboard via TelemetryRecorder (has device context for subscriber
   * filtering), fire-and-forget after the graph write committed.
   */
  private pushNavigationTelemetry(
    event: IncomingNavigationEvent,
    written: { appId: string; nodeId: number; screenName: string; timestamp: number },
  ): void {
    const { appId, nodeId, screenName, timestamp } = written;
    // The device comes with the event from the client that received it: the recorder's
    // ambient context is whichever device last set it, which is another device's with two
    // attached (#10195).
    TelemetryRecorder.getInstance()
      .recordNavigationEvent(
        {
          // SDK time when the client supplied it (iOS), so this record sorts with the device's
          // other telemetry; the graph write above keeps its own `timestamp`.
          timestamp: event.telemetryTimestamp ?? timestamp,
          applicationId: appId,
          destination: screenName,
          source: event.source ?? null,
          arguments: event.arguments ?? null,
          metadata: event.metadata ?? null,
          triggeringInteraction: event.triggeringInteraction ?? null,
          // Scope to `appId` (== the app that just navigated): this URI is pushed live
          // to telemetry-dashboard subscribers, which may be foregrounding a different
          // app when they follow it, so an unscoped form would resolve cross-app (#5600).
          screenshotUri: buildNavigationNodeScreenshotUri(nodeId, appId),
        },
        { deviceId: event.deviceId },
      )
      .catch((error) => {
        logger.warn(
          `[NAVIGATION_GRAPH] Navigation telemetry failed: ${errorMessage(error)}`,
          error,
        );
      });
  }

  /**
   * The screen an edge may start from. An edge starts only from a screen the manager has
   * evidence for: a screen restored after the app returned is a hint, and the process may have
   * died and relaunched since, so it yields no source (#10193 review).
   */
  private edgeSource(): { screen: string | null; unconfirmed: boolean } {
    if (this.state.currentScreenConfirmed || this.state.currentScreen === null) {
      return { screen: this.state.currentScreen, unconfirmed: false };
    }
    return { screen: null, unconfirmed: true };
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
      testCoverageRepository: TestCoverageRepository,
    ) => Promise<T>,
  ): Promise<T> {
    // Enforce the shared-connection precondition BEFORE reserving the connection: the
    // transaction is opened on the navigation connection and the coverage repo is
    // enlisted onto that same `trx`, so a coverage repo bound to a DIFFERENT connection
    // would split writes and defeat the rollback. Holds by construction in production
    // (both default to the getDatabase() singleton); see assertSharedConnection.
    this.assertSharedConnection();

    return this.repository.runInTransaction(async (trx) => {
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
          "Both repositories must share the same connection (both default to the getDatabase() singleton).",
      );
    }
  }

  public async recordHierarchyNavigationUnlocked(
    event: HierarchyNavigationEvent,
    receivedAt: number,
    epoch: number,
  ): Promise<void> {
    const appId = event.packageName?.trim();
    if (!appId) {
      logger.debug(`[NAVIGATION_GRAPH] Skipping hierarchy navigation - unknown app`);
      return;
    }
    // Auto-set current app from package name if provided
    // A hierarchy switch never restores a remembered screen: only the fingerprint lookup below
    // may name the screen, otherwise it stays unknown rather than guessed (#10193).
    if (appId !== this.state.currentAppId) {
      await this.context.setCurrentApp(appId, epoch, {
        restoreScreen: false,
        observedAt: receivedAt,
      });
    }

    assertNavigationWriteCurrent(epoch, this.navigationWriteState);

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
    const provenance = this.context.resolveProvenance(appId);

    // Case 1: Check if fingerprint is already correlated to a named node (scoped to this app)
    const existingNode = await this.repository.getNodeByFingerprint(appId, fingerprintHash);
    assertNavigationWriteCurrent(epoch, this.navigationWriteState);
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
        await recordNodeProvenance(repository, appId, existingNode.id, timestamp, provenance);

        // Record node visit for test coverage if session is active
        if (this.state.activeTestSession) {
          await testCoverageRepository.recordNodeVisit(
            this.state.activeTestSession.id,
            existingNode.id,
            timestamp,
          );
        }

        await repository.touchApp(appId);
      });

      assertNavigationWriteCurrent(epoch, this.navigationWriteState);

      // ---- Post-commit side effects (never inside the transaction) ----
      // Update current screen to the named screen
      this.state.currentScreen = existingNode.screen_name;
      this.state.currentScreenConfirmed = true;

      logger.debug(
        `[NAVIGATION_GRAPH] Hierarchy fingerprint matched node: ${existingNode.screen_name}`,
      );

      this.context.notifyGraphUpdated();
      return;
    }

    // Case 2: Check if within active navigation window - correlate fingerprint to active node
    if (await this.correlateActiveNavigation(appId, event, epoch)) {
      return;
    }

    // Case 3: Check if app has named nodes - create suggestion
    const hasNamedNodes = await this.repository.hasNamedNodes(appId);
    assertNavigationWriteCurrent(epoch, this.navigationWriteState);
    if (hasNamedNodes) {
      // Keep the reach and its provenance atomic; the snapshot above belongs to
      // this event even if another client's context changes while queries await.
      await this.repository.runInTransaction(async (trx) => {
        const repository = this.repository.withExecutor(trx);
        const suggestion = await repository.addOrUpdateSuggestion(
          appId,
          fingerprintHash,
          fingerprintData,
          timestamp,
        );
        const buildKey = await repository.getOrCreateBuildKey(
          appId,
          provenance.versionCode,
          provenance.contentHash,
        );
        await repository.recordSuggestionObservation(
          suggestion.id,
          buildKey.id,
          provenance.deviceId,
          provenance.sessionUuid,
          timestamp,
        );
      });

      logger.debug(
        `[NAVIGATION_GRAPH] Added fingerprint suggestion: ${fingerprintHash.substring(0, 12)}...`,
      );
      return;
    }

    // Case 4: App has no named nodes - do nothing
    // This app doesn't have SDK integration yet, so we don't track hierarchy-only navigation
    logger.debug(`[NAVIGATION_GRAPH] Ignoring hierarchy navigation - app has no named nodes`);
  }

  private async correlateActiveNavigation(
    appId: string,
    event: HierarchyNavigationEvent,
    epoch: number,
  ): Promise<boolean> {
    const navigation = this.state.activeNavigation;
    if (!navigation || navigation.appId !== appId) {
      return false;
    }

    const timeSinceNavigation = event.timestamp - navigation.startTime;
    if (!(timeSinceNavigation >= 0 && timeSinceNavigation <= this.ACTIVE_NAVIGATION_WINDOW_MS)) {
      return false;
    }

    await this.repository.getOrCreateFingerprint(
      appId,
      navigation.nodeId,
      event.toFingerprint,
      event.fingerprintData || JSON.stringify({ hash: event.toFingerprint }),
      event.timestamp,
    );
    assertNavigationWriteCurrent(epoch, this.navigationWriteState);
    logger.info(
      `[NAVIGATION_GRAPH] Correlated fingerprint to ${navigation.screenName} ` +
        `(${timeSinceNavigation}ms after navigation)`,
    );
    this.state.activeNavigation = null;
    return true;
  }
}
