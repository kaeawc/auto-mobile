import { defaultTimer, Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { BootedDevice, Platform } from "../models";
import { KeepScreenAwakeManager, KeepScreenAwakeState } from "../utils/KeepScreenAwakeManager";
import { DeviceSessionRepository, type DeviceSessionPersistence } from "../db/deviceSessionRepository";
import { type DbWriteBarrier, getDbWriteBarrier } from "../db/dbWriteBarrier";
import type { ViewHierarchyResult } from "../models/ViewHierarchyResult";
import type { ObserveResult } from "../models/ObserveResult";

/**
 * Device-label → session-UUID map. `buildDeviceLabelMap` assigns each configured
 * label its own session (the primary label reuses the base session UUID), so a
 * `device: "B"` tool argument can be routed to the correct label session.
 */
export type DeviceLabelMap = Record<string, string>;

/**
 * Narrow seam for restoring keep-awake state on session release. Production uses
 * `KeepScreenAwakeManager`; tests inject a fake to assert (without a real device)
 * that `releaseSession` reads the typed `keepScreenAwake` slot and passes its full
 * payload to `restore` — the behavioral half of the #2973 typed-slot round trip.
 */
export interface KeepScreenAwakeRestorer {
  restore(state: KeepScreenAwakeState): Promise<void>;
}

/**
 * Session Cache Data
 *
 * Stores data that can be reused across multiple tool calls
 * within the same test session, reducing redundant API calls.
 *
 * Every field is a typed top-level slot — the canonical source of truth for its
 * concern (issue #2917). Write each through its dedicated setter
 * (`setLastHierarchy`, `setKeepScreenAwake`, `setDeviceLabels`, …) so a
 * writer/reader type drift is caught at compile time.
 *
 * There is deliberately NO `customData?: Record<string, any>` escape hatch
 * (issue #2973): it previously held well-known, fixed-type keyed state
 * (keep-awake, device-label map) fished out with unchecked `as` casts, which
 * could silently reintroduce the #2917 decoy bug for any key. Any new
 * cross-tool session state gets its own typed slot here, not an untyped bag.
 */
export interface SessionCacheData {
  lastHierarchy?: ViewHierarchyResult; // Last observed view hierarchy (full, untrimmed)
  lastObserveTime?: number;    // Timestamp of last hierarchy observation
  lastRenderedObservation?: ObserveResult; // Last observation emitted to the agent (sanitized), the #2761 diff baseline
  keepScreenAwake?: KeepScreenAwakeState; // Keep-awake state applied at session setup, restored on release
  deviceLabels?: DeviceLabelMap; // Device-label → session map for multi-device (`device:`-labelled) sessions
}

/**
 * Session Record
 *
 * Represents a single test session with an assigned device.
 * Each JUnitRunner test process gets a unique session UUID.
 */
export interface Session {
  sessionId: string;           // UUID provided by JUnitRunner
  assignedDevice: string;      // Device ID this session is using
  platform: Platform;          // Device platform
  createdAt: number;           // Timestamp when session was created
  lastUsedAt: number;          // Last activity timestamp
  expiresAt: number;           // When session will expire (for cleanup)
  cacheData: SessionCacheData; // Cached data for this session
  lastHeartbeat: number;       // Timestamp of last heartbeat
  sessionTimeoutMs: number;    // Idle timeout used when extending this session
  heartbeatTimeoutMs: number;  // Heartbeat timeout for this session
  heartbeatTimeoutSource: "default" | "custom"; // Whether the heartbeat timeout was defaulted or explicitly provided
  hasReceivedHeartbeat: boolean; // Whether any heartbeat has been received
}

/**
 * Session Manager
 *
 * Manages test session lifecycle:
 * - Create sessions with device assignment
 * - Track cache data per session
 * - Release sessions and free up devices
 * - Auto-cleanup expired sessions
 *
 * This enables parallel tests to each have their own device
 * while sharing centralized state in the daemon.
 */
export type SessionReleaseCallback = (sessionId: string, deviceId: string, releaseReason: string) => void;
export interface SessionExecutionMetadata {
  executionId: string;
  startTime: number;
}

export interface ActiveSessionExecutionQuery {
  startedAtOrBefore?: number;
  excludeExecutionId?: string;
}

export type ActiveSessionExecutionChecker = (sessionId: string, query?: ActiveSessionExecutionQuery) => boolean;

export type SessionDeviceUnboundCallback = (sessionId: string, deviceId: string) => void;

interface PendingSessionCreation {
  promise: Promise<Session>;
}

interface PendingSessionRelease {
  promise: Promise<string | null>;
}

interface PendingSessionRebind {
  session: Session;
  promise: Promise<Session>;
}

export interface SessionDeviceAssigner {
  assignDeviceToSession(sessionId: string, platform?: Platform): Promise<string>;
}

const KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS = 1_000;
const SESSION_SETUP_DRAIN_TIMEOUT_MS = 1_000;

export function getDefaultSessionHeartbeatTimeoutMs(): number {
  const rawValue = process.env.AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS
    ?? process.env.AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS;
  const parsed = rawValue ? Number.parseInt(rawValue, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private sessionDeviceMap: Map<string, string> = new Map(); // sessionId -> deviceId
  private deviceSessionMap: Map<string, string> = new Map(); // deviceId -> sessionId (reverse lookup)
  private cleanupTimer: NodeJS.Timeout | null = null;
  private timer: Timer;
  private releaseCallbacks: SessionReleaseCallback[] = [];
  private deviceUnboundCallbacks: SessionDeviceUnboundCallback[] = [];
  private readonly releasePromises: Map<
    string,
    { session: Session; promise: Promise<string | null> }
  > = new Map();
  /** Every release still running, including an older session that reused a UUID. */
  private readonly activeReleasePromises: Set<{ session: Session; promise: Promise<string | null> }> = new Set();
  /** Setup work that can modify device state after a session has been assigned. */
  private readonly sessionSetupPromises: Set<{ session: Session; promise: Promise<void> }> = new Set();
  /** Sessions whose teardown has closed admission for further device-state setup. */
  private readonly releasingSessions: WeakSet<Session> = new WeakSet();
  /**
    * Device work that outlived its bounded release phase. The pool keeps the
    * device assigned until this settles, so no replacement session can race a
   * late setup or keep-awake restore.
  */
  private readonly pendingDeviceCleanups: Map<string, Promise<void>> = new Map();
  /** Creation writes that must finish before a session becomes visible to callers. */
  private readonly pendingSessionCreations: Map<string, PendingSessionCreation> = new Map();
  /** Automatic device assignments that have not yet started their creation write. */
  private readonly pendingSessionAssignments: Map<string, Promise<Session>> = new Map();
  /** Releases received before an assignment has published its session. */
  private readonly pendingSessionReleases: Map<string, PendingSessionRelease> = new Map();
  /** Rebinds that a release must await before it can remove the live binding. */
  private readonly pendingSessionRebinds: Map<string, PendingSessionRebind> = new Map();
  private deviceSessionRepository: DeviceSessionPersistence;
  private readonly getBarrier: () => DbWriteBarrier;
  private readonly keepScreenAwakeRestorerFactory: (device: BootedDevice) => KeepScreenAwakeRestorer;
  private activeSessionExecutionChecker: ActiveSessionExecutionChecker = () => false;

  // Session timeout: 30 minutes
  private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000;

  // Cleanup interval: every 5 minutes
  private readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

  static readonly DEFAULT_HEARTBEAT_TIMEOUT_MS = 10 * 1000;

  constructor(
    timer: Timer = defaultTimer,
    deviceSessionRepository: DeviceSessionPersistence = new DeviceSessionRepository(),
    // Resolve the shared barrier per write, not once at construction, so a
    // same-process DB reopen (resetDbWriteBarrier swaps in a fresh barrier) is
    // seen instead of a pinned drained instance (issue #2912). Because the barrier
    // is resolved per-write here, a same-process daemon restart (tests only) that
    // re-creates writer singletons needs no reconstruction of this SessionManager:
    // closeDatabase() -> resetDbWriteBarrier() cold-starts the barrier and the next
    // track() call picks it up. There is currently no in-process reopen path in
    // production; revisit this note if one is added (issue #3154, follow-up to #2885).
    getBarrier: () => DbWriteBarrier = getDbWriteBarrier,
    // Seam for keep-awake restore (issue #2973): defaults to the real manager;
    // tests inject a fake to assert the typed slot's payload reaches `restore`.
    keepScreenAwakeRestorerFactory: (device: BootedDevice) => KeepScreenAwakeRestorer =
    device => new KeepScreenAwakeManager(device),
  ) {
    this.timer = timer;
    this.deviceSessionRepository = deviceSessionRepository;
    this.getBarrier = getBarrier;
    this.keepScreenAwakeRestorerFactory = keepScreenAwakeRestorerFactory;
    // Start periodic cleanup of expired sessions
    this.startCleanupTimer();
  }

  /**
   * Register a callback to be invoked when a session is released.
   * Used for centralized cleanup of session-scoped state (e.g., NavigationGraphManager).
   */
  onSessionRelease(callback: SessionReleaseCallback): void {
    this.releaseCallbacks.push(callback);
  }

  /** Return outstanding post-release device work, if the device must stay quarantined. */
  getPendingDeviceCleanup(deviceId: string): Promise<void> | null {
    return this.pendingDeviceCleanups.get(deviceId) ?? null;
  }

  /**
   * Keep sessions assigned while their work is still running, even if their
   * idle timeout elapses. The daemon supplies the execution tracker; tests can
   * inject a deterministic checker.
   */
  setActiveSessionExecutionChecker(checker: ActiveSessionExecutionChecker): void {
    this.activeSessionExecutionChecker = checker;
  }

  /**
    * Register cleanup for a device a session stopped using without ending that
    * session. This intentionally excludes session-wide cleanup and transport
    * unbinding, which must remain attached to a real session release.
   */
  onSessionDeviceUnbound(callback: SessionDeviceUnboundCallback): void {
    this.deviceUnboundCallbacks.push(callback);
  }

  /**
   * Create a new session with an assigned device
   *
   * This is called by the daemon when a session UUID is first used.
   * The DevicePool will assign an available device to this session.
   */
  async createSession(
    sessionId: string,
    assignedDevice: string,
    platform: Platform,
    timeoutMs?: number,
    heartbeatTimeoutMs?: number,
  ): Promise<Session> {
    if (this.sessions.has(sessionId)) {
      logger.warn(`Session ${sessionId} already exists, returning existing session`);
      return this.sessions.get(sessionId)!;
    }

    const pendingCreation = this.pendingSessionCreations.get(sessionId);
    if (pendingCreation) {
      return await pendingCreation.promise;
    }

    const now = this.timer.now();
    const sessionTimeoutMs = timeoutMs ?? this.SESSION_TIMEOUT_MS;
    const heartbeatTimeoutSource = heartbeatTimeoutMs === undefined ? "default" : "custom";
    const session: Session = {
      sessionId,
      assignedDevice,
      platform,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + sessionTimeoutMs,
      cacheData: {},
      lastHeartbeat: now,
      sessionTimeoutMs,
      heartbeatTimeoutMs: heartbeatTimeoutMs ?? getDefaultSessionHeartbeatTimeoutMs(),
      heartbeatTimeoutSource,
      hasReceivedHeartbeat: false,
    };

    const creation: PendingSessionCreation = { promise: this.persistAndPublishSession(session) };
    this.pendingSessionCreations.set(sessionId, creation);
    try {
      return await creation.promise;
    } finally {
      if (this.pendingSessionCreations.get(sessionId) === creation) {
        this.pendingSessionCreations.delete(sessionId);
      }
    }
  }

  private async persistAndPublishSession(session: Session): Promise<Session> {
    await this.persistSession(session);
    this.sessions.set(session.sessionId, session);
    this.sessionDeviceMap.set(session.sessionId, session.assignedDevice);
    this.deviceSessionMap.set(session.assignedDevice, session.sessionId);
    logger.info(`Created session ${session.sessionId} with device ${session.assignedDevice}`);
    return session;
  }

  /**
   * Get existing session
   */
  getSession(sessionId: string): Session | null {
    return this.getSessionInternal(sessionId, false);
  }

  /**
   * Resolve a session before a new tool execution is accepted. Existing work may
   * defer expiry cleanup, but it must not let a request that arrived after the
   * deadline revive an expired session.
   */
  getSessionForNewExecution(sessionId: string, execution?: SessionExecutionMetadata): Session | null {
    return this.getSessionInternal(sessionId, true, execution);
  }

  private getSessionInternal(
    sessionId: string,
    expireDespiteActiveExecution: boolean,
    execution?: SessionExecutionMetadata,
  ): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    if (expireDespiteActiveExecution && this.isLateExecutionWhileEarlierWorkIsActive(session, execution)) {
      throw new Error(
        `Session ${sessionId} expired before this execution began while earlier work is still active.`,
      );
    }
    if (this.shouldExpireSession(session, expireDespiteActiveExecution, execution)) {
      // Release owns this exact session object until it has restored device state
      // and removed its assignment. Keep expiry cleanup from creating a second
      // incarnation with the same UUID before teardown completes.
      if (this.releasingSessions.has(session)) {
        return session;
      }
      logger.info(`Session ${sessionId} has expired, releasing`);
      const release = this.releaseSession(sessionId, "lazy-expiry", true);
      void this.getBarrier()
        .trackExisting(release)
        .catch(error => logger.warn(`[SessionManager] Failed to release expired session ${sessionId}: ${error}`));
      return null;
    }
    return session;
  }

  private shouldExpireSession(
    session: Session,
    expireDespiteActiveExecution: boolean,
    execution?: SessionExecutionMetadata,
  ): boolean {
    return expireDespiteActiveExecution
      ? this.isSessionExpiredForNewExecution(session, execution)
      : this.isSessionExpired(session);
  }

  /**
   * Get or create session with device assignment
   *
   * Automatically creates a session if it doesn't exist.
   * Called when --session-uuid is provided to a CLI command.
   *
   * @param sessionId - The session UUID
   * @param devicePool - DevicePool instance for automatic device assignment
   */
  async getOrCreateSession(
    sessionId: string,
    devicePool?: SessionDeviceAssigner,
    platform?: Platform,
    execution?: SessionExecutionMetadata,
  ): Promise<Session> {
    const existing = this.getSessionForNewExecution(sessionId, execution);
    if (existing) {
      const inFlightRelease = this.releasePromises.get(sessionId);
      if (this.releasingSessions.has(existing) && inFlightRelease?.session === existing) {
        await inFlightRelease.promise;
        return await this.getOrCreateSession(sessionId, devicePool, platform);
      }
      logger.info(`[SessionManager] Found existing session ${sessionId} with device ${existing.assignedDevice}`);
      // Resolving a session for a tool call is activity: extend both the idle
      // timeout (expiresAt) and the heartbeat clock (lastHeartbeat). Without the
      // latter, the daemon heartbeat watchdog would reap an actively-used session
      // whose tools never write session cache (e.g. autolock CLI/agent clients
      // that do not send explicit heartbeats).
      const now = this.timer.now();
      existing.lastUsedAt = now;
      existing.lastHeartbeat = now;
      existing.expiresAt = now + existing.sessionTimeoutMs;
      await this.recordSessionActivity(existing);
      return existing;
    }

    const pendingAssignment = this.pendingSessionAssignments.get(sessionId);
    if (pendingAssignment) {
      return await pendingAssignment;
    }

    const pendingCreation = this.pendingSessionCreations.get(sessionId);
    if (pendingCreation) {
      return await pendingCreation.promise;
    }

    const assignment = this.createUnseenSession(sessionId, devicePool, platform).finally(() => {
      if (this.pendingSessionAssignments.get(sessionId) === assignment) {
        this.pendingSessionAssignments.delete(sessionId);
      }
    });
    this.pendingSessionAssignments.set(sessionId, assignment);
    return await assignment;
  }

  private async createUnseenSession(
    sessionId: string,
    devicePool: SessionDeviceAssigner | undefined,
    platform: Platform | undefined,
  ): Promise<Session> {
    logger.info(`[SessionManager] Creating new session ${sessionId}, calling devicePool.assignDeviceToSession()`);

    // Need to create new session - assign device from pool
    if (!devicePool) {
      throw new Error(
        `Session ${sessionId} not found and no device pool provided for auto-assignment.`
      );
    }

    // DevicePool will call createSession() with assigned device
    await devicePool.assignDeviceToSession(sessionId, platform);

    // Session now exists, return it
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(
        `Session ${sessionId} creation failed after device assignment`
      );
    }

    logger.info(`[SessionManager] Successfully created session ${sessionId} with device ${session.assignedDevice}`);
    return session;
  }

  async rebindSession(
    sessionId: string,
    assignedDevice: string,
    platform: Platform,
  ): Promise<Session> {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      return await this.createSession(sessionId, assignedDevice, platform);
    }
    if (existing.assignedDevice === assignedDevice) {
      return existing;
    }

    const pendingRebind = this.pendingSessionRebinds.get(sessionId);
    if (pendingRebind) {
      await pendingRebind.promise;
      return await this.rebindSession(sessionId, assignedDevice, platform);
    }

    const inFlightRelease = this.releasePromises.get(sessionId);
    if (inFlightRelease?.session === existing) {
      await inFlightRelease.promise;
      throw new Error(`Cannot rebind released session ${sessionId}.`);
    }

    const promise = this.persistAndPublishRebind(existing, assignedDevice, platform);
    const rebind = { session: existing, promise };
    this.pendingSessionRebinds.set(sessionId, rebind);
    try {
      return await promise;
    } finally {
      if (this.pendingSessionRebinds.get(sessionId) === rebind) {
        this.pendingSessionRebinds.delete(sessionId);
      }
    }
  }

  private async persistAndPublishRebind(
    existing: Session,
    assignedDevice: string,
    platform: Platform,
  ): Promise<Session> {
    const replacement: Session = {
      ...existing,
      assignedDevice,
      platform,
      cacheData: {},
    };
    await this.persistSession(replacement);

    try {
      await this.restoreKeepScreenAwake(existing);
    } catch (error) {
      logger.warn(`Failed to restore keep-awake state for rebound session ${existing.sessionId}: ${error}`);
    }

    const previousDevice = existing.assignedDevice;
    // Preserve object identity so an already-started release observes the
    // rebinding and frees its live replacement rather than a stale snapshot.
    Object.assign(existing, replacement);
    this.sessionDeviceMap.set(existing.sessionId, assignedDevice);
    if (this.deviceSessionMap.get(previousDevice) === existing.sessionId) {
      this.deviceSessionMap.delete(previousDevice);
    }
    this.deviceSessionMap.set(assignedDevice, existing.sessionId);
    this.notifySessionDeviceUnbound(existing.sessionId, previousDevice);
    return existing;
  }

  /**
   * Get device assigned to a session
   */
  getDeviceForSession(sessionId: string): string | null {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }
    return session.assignedDevice;
  }

  /**
   * Get session assigned to a device (reverse lookup)
   */
  getSessionForDevice(deviceId: string): string | null {
    return this.deviceSessionMap.get(deviceId) ?? null;
  }

  isCurrentSession(session: Session): boolean {
    return this.sessions.get(session.sessionId) === session;
  }

  /**
   * Release a session and free its device
   *
   * Called when a test completes or times out.
   * Returns the device ID so DevicePool can mark it as available.
   */
  async releaseSession(
    sessionId: string,
    releaseReason: string = "explicit-release",
    allowExpired: boolean = false,
  ): Promise<string | null> {
    const session = allowExpired ? this.sessions.get(sessionId) ?? null : this.getSession(sessionId);
    if (!session) {
      return await this.releaseUnpublishedSession(sessionId, releaseReason, allowExpired);
    }

    const inFlightRelease = this.releasePromises.get(sessionId);
    if (inFlightRelease?.session === session) {
      return await inFlightRelease.promise;
    }

    this.releasingSessions.add(session);
    const pendingRebind = this.pendingSessionRebinds.get(sessionId);
    const promise = pendingRebind?.session === session
      ? pendingRebind.promise.then(
        () => this.releaseSessionInternal(sessionId, session, releaseReason),
        () => this.releaseSessionInternal(sessionId, session, releaseReason),
      )
      : this.releaseSessionInternal(sessionId, session, releaseReason);
    const release = { session, promise };
    this.releasePromises.set(sessionId, release);
    this.activeReleasePromises.add(release);
    try {
      return await promise;
    } finally {
      this.activeReleasePromises.delete(release);
      if (this.releasePromises.get(sessionId) === release) {
        this.releasePromises.delete(sessionId);
      }
    }
  }

  /** Release only the recorded session incarnation while it still owns the device. */
  async releaseSessionIfOwned(
    sessionId: string,
    expectedSession: Session,
    expectedDeviceId: string,
    releaseReason: string = "explicit-release",
  ): Promise<string | null> {
    const session = this.sessions.get(sessionId);
    if (session !== expectedSession || session.assignedDevice !== expectedDeviceId) {
      return null;
    }
    return await this.releaseSession(sessionId, releaseReason);
  }

  private async releaseUnpublishedSession(
    sessionId: string,
    releaseReason: string,
    allowExpired: boolean,
  ): Promise<string | null> {
    const inFlightRelease = this.releasePromises.get(sessionId);
    if (inFlightRelease) {
      return await inFlightRelease.promise;
    }
    const pendingAssignment = this.pendingSessionAssignments.get(sessionId);
    const pendingCreation = this.pendingSessionCreations.get(sessionId);
    const pendingSession = pendingAssignment ?? pendingCreation?.promise;
    if (!pendingSession) {
      logger.warn(`Cannot release session ${sessionId}: not found`);
      return null;
    }
    return await this.releasePendingSessionWork(sessionId, releaseReason, allowExpired, pendingSession);
  }

  private async releasePendingSessionWork(
    sessionId: string,
    releaseReason: string,
    allowExpired: boolean,
    pendingSession: Promise<Session>,
  ): Promise<string | null> {
    const existingRelease = this.pendingSessionReleases.get(sessionId);
    if (existingRelease) {
      return await existingRelease.promise;
    }

    const release: PendingSessionRelease = {
      promise: this.releaseAfterPendingSessionWork(
        sessionId,
        releaseReason,
        allowExpired,
        pendingSession,
      ),
    };
    this.pendingSessionReleases.set(sessionId, release);
    try {
      return await release.promise;
    } finally {
      if (this.pendingSessionReleases.get(sessionId) === release) {
        this.pendingSessionReleases.delete(sessionId);
      }
    }
  }

  private async releaseAfterPendingSessionWork(
    sessionId: string,
    releaseReason: string,
    allowExpired: boolean,
    pendingSession: Promise<Session>,
  ): Promise<string | null> {
    try {
      await pendingSession;
      return await this.releaseSession(sessionId, releaseReason, allowExpired);
    } catch (error) {
      logger.warn(`Session ${sessionId} assignment failed before release: ${error}`);
      return null;
    }
  }

  /**
   * Track setup that can modify device state after a session has been assigned.
   * Release waits for this work so restoration sees the final cached state.
   */
  trackSessionSetup(session: Session, createSetup: () => Promise<void>): Promise<void> {
    if (this.releasingSessions.has(session) || this.sessions.get(session.sessionId) !== session) {
      return Promise.resolve();
    }

    let resolveSetup!: () => void;
    let rejectSetup!: (error: unknown) => void;
    const setup = new Promise<void>((resolve, reject) => {
      resolveSetup = resolve;
      rejectSetup = reject;
    });
    const tracked = { session, promise: setup };
    this.sessionSetupPromises.add(tracked);
    try {
      void createSetup().then(resolveSetup, rejectSetup);
    } catch (error) {
      logger.warn(`Session setup factory failed for ${session.sessionId}: ${error}`);
      rejectSetup(error);
    }
    void setup.then(
      () => this.clearSessionSetup(tracked),
      () => this.clearSessionSetup(tracked),
    );
    return setup;
  }

  /** Wait a bounded amount of time for releases already started by monitors. */
  async drainReleasePromises(timeoutMs: number): Promise<boolean> {
    const releases = Array.from(this.activeReleasePromises, release => release.promise);
    if (releases.length === 0) {
      return true;
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>(resolve => {
      timeoutHandle = this.timer.setTimeout(() => resolve(false), timeoutMs);
    });

    try {
      return await Promise.race([Promise.allSettled(releases).then(() => true), timeout]);
    } finally {
      if (timeoutHandle !== undefined) {
        this.timer.clearTimeout(timeoutHandle);
      }
    }
  }

  /** Wait for a release already admitted for this session, if any. */
  async waitForSessionRelease(sessionId: string): Promise<void> {
    const pendingSessionRelease = this.pendingSessionReleases.get(sessionId);
    if (pendingSessionRelease) {
      await pendingSessionRelease.promise;
      return;
    }

    const release = this.releasePromises.get(sessionId);
    if (release) {
      await release.promise;
    }
  }

  private async releaseSessionInternal(
    sessionId: string,
    session: Session,
    releaseReason: string,
  ): Promise<string | null> {
    try {
      const setups = Array.from(this.sessionSetupPromises, setup => setup.session === session ? setup.promise : null)
        .filter((setup): setup is Promise<void> => setup !== null);
      const pendingSetups = setups.length > 0
        ? (await this.waitForSessionSetup(sessionId, setups)).pending
        : null;
      const pendingRestoration = (await this.restoreKeepScreenAwakeBestEffort(session)).pending;
      const pendingCleanup = [pendingSetups, pendingRestoration]
        .filter((cleanup): cleanup is Promise<void> => cleanup !== null);
      const deviceId = session.assignedDevice;

      if (!this.removeSession(sessionId, session)) {
        if (pendingCleanup.length > 0) {this.trackPendingDeviceCleanup(deviceId, pendingCleanup);}
        logger.warn(`Skipping release finalization for ${sessionId}: session ownership changed`);
        return null;
      }
      if (pendingCleanup.length > 0) {this.trackPendingDeviceCleanup(deviceId, pendingCleanup);}

      try {
        await this.deviceSessionRepository.markReleased(sessionId, "released", this.timer.now(), releaseReason);
      } catch (error) {
        logger.warn(`[SessionManager] Failed to mark session released (${releaseReason}): ${error}`);
      }
      for (const callback of this.releaseCallbacks) {
        try {
          callback(sessionId, deviceId, releaseReason);
        } catch (error) {
          logger.warn(`Session release callback failed for ${sessionId}: ${error}`);
        }
      }
      logger.info(
        pendingCleanup.length > 0
          ? `Released session ${sessionId}; device ${deviceId} remains quarantined until teardown completes`
          : `Released session ${sessionId}, freeing device ${deviceId}`,
      );
      return deviceId;
    } finally {
      this.releasingSessions.delete(session);
    }
  }

  private clearSessionSetup(tracked: { session: Session; promise: Promise<void> }): void {
    this.sessionSetupPromises.delete(tracked);
  }

  private async waitForSessionSetup(
    sessionId: string,
    setups: readonly Promise<void>[],
  ): Promise<{ pending: Promise<void> | null }> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const settled = Promise.allSettled(setups);
    const timeout = new Promise<"timed-out">(resolve => {
      timeoutHandle = this.timer.setTimeout(() => resolve("timed-out"), SESSION_SETUP_DRAIN_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([settled, timeout]);
      if (result === "timed-out") {
        logger.warn(`Timed out after ${SESSION_SETUP_DRAIN_TIMEOUT_MS}ms waiting for session ${sessionId} setup during release`);
        return { pending: settled.then(() => undefined) };
      }
      for (const setup of result) {
        if (setup.status === "rejected") {logger.warn(`Failed session setup for ${sessionId} before release: ${setup.reason}`);}
      }
      return { pending: null };
    } finally {
      if (timeoutHandle !== undefined) {this.timer.clearTimeout(timeoutHandle);}
    }
  }

  private async restoreKeepScreenAwakeBestEffort(session: Session): Promise<{ pending: Promise<void> | null }> {
    if (!session.cacheData.keepScreenAwake?.applied) {
      return { pending: null };
    }
    let timeoutHandle: NodeJS.Timeout | undefined;
    const restoration = this.restoreKeepScreenAwake(session).then(
      () => ({ outcome: "restored" as const }),
      error => ({ outcome: "failed" as const, error }),
    );
    const timeout = new Promise<{ outcome: "timed-out" }>(resolve => {
      timeoutHandle = this.timer.setTimeout(() => resolve({ outcome: "timed-out" }), KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([restoration, timeout]);
      if (result.outcome === "failed") {
        logger.warn(`Failed to restore keep-awake state for session ${session.sessionId}: ${result.error}`);
      } else if (result.outcome === "timed-out") {
        logger.warn(
          `Timed out after ${KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS}ms restoring keep-awake state for session ${session.sessionId}`,
        );
        return { pending: restoration.then(() => undefined) };
      }
      return { pending: null };
    } finally {
      if (timeoutHandle !== undefined) {this.timer.clearTimeout(timeoutHandle);}
    }
  }

  private trackPendingDeviceCleanup(deviceId: string, cleanups: readonly Promise<void>[]): void {
    const previous = this.pendingDeviceCleanups.get(deviceId);
    const cleanup = Promise.allSettled(previous ? [previous, ...cleanups] : cleanups)
      .then(() => undefined);
    this.pendingDeviceCleanups.set(deviceId, cleanup);
    void cleanup.then(() => {
      if (this.pendingDeviceCleanups.get(deviceId) === cleanup) {
        this.pendingDeviceCleanups.delete(deviceId);
      }
    });
  }

  private notifySessionDeviceUnbound(sessionId: string, deviceId: string): void {
    for (const callback of this.deviceUnboundCallbacks) {
      try {
        callback(sessionId, deviceId);
      } catch (error) {
        logger.warn(`Session device-unbound callback failed for ${sessionId}: ${error}`);
      }
    }
  }

  /**
   * Update session cache data
   *
   * Allows tools to store data (screenshots, hierarchies) that can be
   * reused by other tools in the same session without re-fetching.
   */
  updateSessionCache(
    sessionId: string,
    updates: Partial<SessionCacheData>
  ): void {
    const session = this.getSession(sessionId);
    if (!session) {
      logger.warn(`Cannot update cache for session ${sessionId}: not found`);
      return;
    }

    session.cacheData = {
      ...session.cacheData,
      ...updates,
    };
    session.lastUsedAt = this.timer.now();
    session.lastHeartbeat = this.timer.now();
    void this.getBarrier()
      .track(() => this.recordSessionActivity(session))
      .catch(error => logger.warn(`[SessionManager] Failed to record session activity: ${error}`));

    logger.debug(`Updated cache for session ${sessionId}`);
  }

  /**
   * Cache the most recent observed view hierarchy for a session.
   *
   * Writes the typed top-level `lastHierarchy` slot (the canonical source of
   * truth per issue #2917) and stamps `lastObserveTime`. Consumers such as the
   * hierarchy-diff baseline (#2761) read the typed slot directly rather than
   * fishing a differently-typed value out of `customData`.
   */
  setLastHierarchy(sessionId: string, hierarchy: ViewHierarchyResult): void {
    this.updateSessionCache(sessionId, {
      lastHierarchy: hierarchy,
      lastObserveTime: this.timer.now(),
    });
  }

  /**
   * Cache the most recent observation emitted to the agent (the sanitized
   * `ObserveResult`) as the diff baseline for `--actions-diff-observe` (#2761).
   *
   * This is the "last observation output to the agent": `observe` resets it to
   * the full sanitized observation, and each non-observe action updates it to
   * its own post-action observation so the *next* action diffs against current
   * state. Stored in a typed top-level slot (canonical per #2917) rather than
   * the untyped `customData` bag. Distinct from `lastHierarchy`, which keeps the
   * full untrimmed hierarchy for internal reuse; this holds the wire-shaped
   * observation so diffs compare like-for-like.
   */
  setLastRenderedObservation(sessionId: string, observation: ObserveResult): void {
    this.updateSessionCache(sessionId, { lastRenderedObservation: observation });
  }

  /**
   * Read the diff baseline (`lastRenderedObservation`) without recording session
   * activity (issue #3053). The `--actions-diff-observe` baseline store reads the
   * baseline on every non-observe action; routing that read through
   * `getSessionCache` would fire a second `recordActivity` UPDATE on top of the
   * `set` that follows (get + set = two fire-and-forget writes per diffed action).
   * This reader goes straight through `getSession`, which does not record activity
   * (its only mutation is lazy expiry — the same GC any session lookup triggers),
   * so a diffed action records activity once — from the baseline `set` — not twice.
   * Returns `undefined` for an unknown/expired session or when no observation has
   * been rendered yet.
   */
  getLastRenderedObservation(sessionId: string): ObserveResult | undefined {
    return this.getSession(sessionId)?.cacheData.lastRenderedObservation;
  }

  /**
   * Cache the keep-awake state applied for a session in the typed top-level
   * `keepScreenAwake` slot (issue #2973). `ToolExecutionContext` writes it once at
   * session setup; `restoreKeepScreenAwake` reads the same slot on release. Both
   * go through this typed slot rather than an untyped `customData` cast, so a
   * writer/reader type drift is a compile error (the #2917 bug class).
   */
  setKeepScreenAwake(sessionId: string, state: KeepScreenAwakeState): void {
    this.updateSessionCache(sessionId, { keepScreenAwake: state });
  }

  /**
   * Read the keep-awake state without recording session activity (mirrors
   * `getLastRenderedObservation`, issue #3053): this is a best-effort setup/restore
   * read, not a tool interaction, so it must not fire a session-activity write.
   * Returns `undefined` for an unknown/expired session or before setup ran.
   */
  getKeepScreenAwake(sessionId: string): KeepScreenAwakeState | undefined {
    return this.getSession(sessionId)?.cacheData.keepScreenAwake;
  }

  /**
   * Cache the device-label → session map for a multi-device session in the typed
   * top-level `deviceLabels` slot (issue #2973). Written by `registerDeviceLabelMap`
   * and read on the `device:`-label routing hot path (`resolveDeviceLabelSession`).
   */
  setDeviceLabels(sessionId: string, labels: DeviceLabelMap): void {
    this.updateSessionCache(sessionId, { deviceLabels: labels });
  }

  /**
   * Read the device-label map without recording session activity (issue #3053):
   * label routing reads this on every `device:`-labelled request, so it must not
   * fire a session-activity write per read. Returns `undefined` for an
   * unknown/expired session or a session with no registered labels.
   */
  getDeviceLabels(sessionId: string): DeviceLabelMap | undefined {
    return this.getSession(sessionId)?.cacheData.deviceLabels;
  }

  /**
   * Get session cache data
   */
  getSessionCache(sessionId: string): SessionCacheData | null {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }

    // Update last used time when accessing cache
    session.lastUsedAt = this.timer.now();
    session.lastHeartbeat = this.timer.now();
    void this.getBarrier()
      .track(() => this.recordSessionActivity(session))
      .catch(error => logger.warn(`[SessionManager] Failed to record session activity: ${error}`));

    return session.cacheData;
  }

  /**
   * Record a heartbeat for a session
   */
  recordHeartbeat(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (!session) {
      logger.warn(`Cannot record heartbeat for session ${sessionId}: not found`);
      return;
    }
    const now = this.timer.now();
    session.lastHeartbeat = now;
    session.lastUsedAt = now;
    session.expiresAt = now + session.sessionTimeoutMs;
    session.hasReceivedHeartbeat = true;
    void this.getBarrier()
      .track(() => this.recordSessionActivity(session))
      .catch(error => logger.warn(`[SessionManager] Failed to record session activity: ${error}`));
  }

  /**
   * Clear session cache (for specific key or all)
   */
  clearSessionCache(sessionId: string, key?: string): void {
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }

    if (key) {
      delete session.cacheData[key as keyof SessionCacheData];
    } else {
      session.cacheData = {};
    }

    logger.debug(
      `Cleared cache for session ${sessionId}${key ? ` (key: ${key})` : " (all)"}`
    );
  }

  /**
   * Get count of active sessions
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values()).filter(
      s => !this.isSessionExpired(s)
    );
  }

  /** Snapshot every in-memory session, including expired entries awaiting cleanup. */
  getAllSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get all devices currently assigned to sessions
   */
  getAssignedDevices(): Set<string> {
    return new Set(
      Array.from(this.sessions.values())
        .filter(s => !this.isSessionExpired(s))
        .map(s => s.assignedDevice)
    );
  }

  /**
   * Check if session is expired
   */
  private isSessionExpired(session: Session): boolean {
    return !this.activeSessionExecutionChecker(session.sessionId)
      && this.timer.now() > session.expiresAt;
  }

  private isSessionExpiredForNewExecution(session: Session, execution?: SessionExecutionMetadata): boolean {
    if (this.timer.now() <= session.expiresAt) {
      return false;
    }
    return execution?.startTime === undefined || execution.startTime > session.expiresAt;
  }

  private isLateExecutionWhileEarlierWorkIsActive(
    session: Session,
    execution: SessionExecutionMetadata | undefined,
  ): boolean {
    return execution !== undefined
      && this.timer.now() > session.expiresAt
      && execution.startTime > session.expiresAt
      && this.activeSessionExecutionChecker(session.sessionId, {
        excludeExecutionId: execution.executionId,
      });
  }

  /**
   * Remove session from all maps
   */
  private removeSession(sessionId: string, expectedSession?: Session): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || (expectedSession && session !== expectedSession)) {
      return false;
    }
    if (this.deviceSessionMap.get(session.assignedDevice) === sessionId) {
      this.deviceSessionMap.delete(session.assignedDevice);
    }
    this.sessions.delete(sessionId);
    this.sessionDeviceMap.delete(sessionId);
    return true;
  }

  private async restoreKeepScreenAwake(session: Session): Promise<void> {
    if (session.platform !== "android") {
      return;
    }
    const state = session.cacheData.keepScreenAwake;
    if (!state || !state.applied) {
      return;
    }

    const device: BootedDevice = {
      name: session.assignedDevice,
      platform: session.platform,
      deviceId: session.assignedDevice
    };
    const manager = this.keepScreenAwakeRestorerFactory(device);
    await manager.restore(state);
  }

  /**
   * Remove all expired sessions and fire release callbacks for them.
   *
   * Runs on the periodic cleanup timer, but is also invoked by the heartbeat
   * monitor on its (much shorter) interval so that idle sessions — including
   * autolocked devices, whose idle timeout equals their heartbeat timeout — are
   * released promptly instead of waiting for the next 5-minute sweep.
   */
  cleanupExpiredSessions(): void {
    const expiredSessions: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      if (this.isSessionExpired(session) && !this.releasingSessions.has(session)) {
        expiredSessions.push(sessionId);
      }
    }

    if (expiredSessions.length === 0) {
      return;
    }

    logger.info(
      `Cleaning up ${expiredSessions.length} expired sessions: ` +
      expiredSessions.join(", ")
    );

    for (const sessionId of expiredSessions) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        continue;
      }
      const release = this.releaseSession(sessionId, "cleanup-expired", true);
      void this.getBarrier()
        .trackExisting(release)
        .catch(error => logger.warn(`[SessionManager] Failed to release expired session ${sessionId}: ${error}`));
    }
  }

  /**
   * Start periodic cleanup of expired sessions
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = this.timer.setInterval(() => {
      this.cleanupExpiredSessions();
    }, this.CLEANUP_INTERVAL_MS);

    // Allow process to exit even if timer is running
    if (this.cleanupTimer && typeof (this.cleanupTimer as { unref?: () => void }).unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop cleanup timer (called on daemon shutdown)
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      this.timer.clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // Intentionally NOT barrier-tracked: this write is `await`ed by its caller
  // (createSession), so it is caller-tied, not fire-and-forget. The DbWriteBarrier
  // (issue #2885) only drains fire-and-forget writers at graceful shutdown; an
  // awaited write is already sequenced by its caller and must not be wrapped in
  // `track()`. Do not "fix" this by adding a barrier — that would be a non-bug fix.
  private async persistSession(session: Session): Promise<void> {
    await this.deviceSessionRepository.upsertActiveSession({
      sessionUuid: session.sessionId,
      deviceId: session.assignedDevice,
      platform: session.platform,
      source: "session-manager",
      createdAtMs: session.createdAt,
      lastUsedAtMs: session.lastUsedAt,
      expiresAtMs: session.expiresAt,
      sessionTimeoutMs: session.sessionTimeoutMs,
      heartbeatTimeoutMs: session.heartbeatTimeoutMs,
      hasReceivedHeartbeat: session.hasReceivedHeartbeat,
    });
  }

  // Intentionally NOT barrier-tracked when reached via the awaited path
  // (getOrCreateSession -> `await recordSessionActivity`): that path is caller-tied,
  // not fire-and-forget, so the DbWriteBarrier deliberately does not cover it. The
  // fire-and-forget callers above wrap this in `getBarrier().track(...)`; the awaited
  // caller must not. See #2885 — do not wrap the awaited call in `track()`.
  private async recordSessionActivity(session: Session): Promise<void> {
    await this.deviceSessionRepository.recordActivity(session.sessionId, {
      lastUsedAtMs: session.lastUsedAt,
      expiresAtMs: session.expiresAt,
      hasReceivedHeartbeat: session.hasReceivedHeartbeat,
    });
  }

  /**
   * Get statistics for monitoring
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    expiredSessions: number;
    assignedDevices: number;
    } {
    const activeSessions = this.getAllSessions().length;
    const expiredSessions = this.sessions.size - activeSessions;

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      expiredSessions,
      assignedDevices: this.getAssignedDevices().size,
    };
  }
}
