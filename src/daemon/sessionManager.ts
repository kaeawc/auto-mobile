import { defaultTimer, Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { BootedDevice, Platform } from "../models";
import { KeepScreenAwakeManager, KeepScreenAwakeState } from "../utils/KeepScreenAwakeManager";
import { DeviceSessionRepository } from "../db/deviceSessionRepository";
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
export type SessionReleaseCallback = (sessionId: string, deviceId: string) => void;

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
  private readonly releasePromises: Map<
    string,
    { session: Session; promise: Promise<string | null> }
  > = new Map();
  /** Every release still running, including an older session that reused a UUID. */
  private readonly activeReleasePromises: Set<{ session: Session; promise: Promise<string | null> }> = new Set();
  /** Setup work that must settle before a session restores its cached device state. */
  private readonly sessionSetupPromises: Set<{ session: Session; promise: Promise<void> }> = new Set();
  /** Sessions whose teardown has closed admission for further device-state setup. */
  private readonly releasingSessions: WeakSet<Session> = new WeakSet();
  private deviceSessionRepository: DeviceSessionRepository;
  private readonly getBarrier: () => DbWriteBarrier;
  private readonly keepScreenAwakeRestorerFactory: (device: BootedDevice) => KeepScreenAwakeRestorer;

  // Session timeout: 30 minutes
  private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000;

  // Cleanup interval: every 5 minutes
  private readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

  static readonly DEFAULT_HEARTBEAT_TIMEOUT_MS = 10 * 1000;

  constructor(
    timer: Timer = defaultTimer,
    deviceSessionRepository: DeviceSessionRepository = new DeviceSessionRepository(),
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

    this.sessions.set(sessionId, session);
    this.sessionDeviceMap.set(sessionId, assignedDevice);
    this.deviceSessionMap.set(assignedDevice, sessionId);
    await this.persistSession(session);

    logger.info(`Created session ${sessionId} with device ${assignedDevice}`);
    return session;
  }

  /**
   * Get existing session
   */
  getSession(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (session && this.isSessionExpired(session)) {
      // Release owns this exact session object until it has restored device state
      // and removed its assignment. Keep expiry cleanup from creating a second
      // incarnation with the same UUID before teardown completes.
      if (this.releasingSessions.has(session)) {
        return session;
      }
      logger.info(`Session ${sessionId} has expired, removing`);
      const deviceId = session.assignedDevice;
      this.removeSession(sessionId);
      void this.getBarrier()
        .track(() => this.deviceSessionRepository.markReleased(sessionId, "expired", this.timer.now(), "lazy-expiry"))
        .catch(error => logger.warn(`[SessionManager] Failed to mark session released (lazy-expiry): ${error}`));
      // Notify release callbacks so session-scoped state is cleaned up
      for (const callback of this.releaseCallbacks) {
        try {
          callback(sessionId, deviceId);
        } catch (error) {
          logger.warn(`Session expiry callback failed for ${sessionId}: ${error}`);
        }
      }
      return null;
    }
    return session || null;
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
    devicePool?: import("./devicePool").DevicePool,
    platform?: Platform
  ): Promise<Session> {
    const existing = this.getSession(sessionId);
    if (existing) {
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
    // Match the promise to this particular session object, rather than only its
    // UUID. A caller can create a new session with a reused UUID after the old
    // release has removed it but before that release's persistence finishes.
    const session = allowExpired ? this.sessions.get(sessionId) ?? null : this.getSession(sessionId);
    if (!session) {
      logger.warn(`Cannot release session ${sessionId}: not found`);
      return null;
    }

    const inFlightRelease = this.releasePromises.get(sessionId);
    if (inFlightRelease?.session === session) {
      return await inFlightRelease.promise;
    }

    this.releasingSessions.add(session);
    const promise = this.releaseSessionInternal(sessionId, session, releaseReason);
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

  /**
   * Track setup that can modify device state after a session has been assigned.
   * Release waits for this work so restoration sees the final cached state.
   */
  trackSessionSetup(session: Session, setupFactory: () => Promise<void>): Promise<void> {
    if (this.releasingSessions.has(session) || this.sessions.get(session.sessionId) !== session) {
      return Promise.resolve();
    }

    const setup = setupFactory();
    const tracked = { session, promise: setup };
    this.sessionSetupPromises.add(tracked);
    void setup.then(
      () => this.clearSessionSetup(tracked),
      () => this.clearSessionSetup(tracked)
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

  private async releaseSessionInternal(
    sessionId: string,
    session: Session,
    releaseReason: string,
  ): Promise<string | null> {
    const setups = Array.from(this.sessionSetupPromises, setup => setup.session === session ? setup.promise : null)
      .filter((setup): setup is Promise<void> => setup !== null);
    if (setups.length > 0) {
      const setupResults = await Promise.allSettled(setups);
      for (const result of setupResults) {
        if (result.status === "rejected") {
          logger.warn(`Failed session setup for ${sessionId} before release: ${result.reason}`);
        }
      }
    }

    try {
      await this.restoreKeepScreenAwake(session);
    } catch (error) {
      // Releasing a session must still remove its device assignment and persist
      // its terminal state when restoration fails. The restore is best-effort;
      // retaining the session would leak the device and leave the durable row
      // active during shutdown.
      logger.warn(`Failed to restore keep-awake state for session ${sessionId}: ${error}`);
    }

    const deviceId = session.assignedDevice;
    if (!this.removeSession(sessionId, session)) {
      logger.warn(`Skipping release finalization for ${sessionId}: session ownership changed`);
      return null;
    }
    // Intentionally NOT barrier-tracked: releaseSession is awaited by its caller
    // (explicit release), so this write is caller-tied, not fire-and-forget. Only
    // the lazy-expiry / cleanup-expired markReleased calls above are fire-and-forget
    // and therefore barrier-tracked. The cleanup/disconnect timers are cleared before
    // the shutdown drain (#2792/#2912), so awaited writes have small exposure. Do not
    // wrap this in the DbWriteBarrier (#2885) — that would be a non-bug fix.
    await this.deviceSessionRepository.markReleased(sessionId, "released", this.timer.now(), releaseReason);

    // Notify release callbacks for centralized cleanup
    for (const callback of this.releaseCallbacks) {
      try {
        callback(sessionId, deviceId);
      } catch (error) {
        logger.warn(`Session release callback failed for ${sessionId}: ${error}`);
      }
    }

    logger.info(`Released session ${sessionId}, freeing device ${deviceId}`);

    return deviceId;
  }

  private clearSessionSetup(
    tracked: { session: Session; promise: Promise<void> },
  ): void {
    this.sessionSetupPromises.delete(tracked);
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
    return this.timer.now() > session.expiresAt;
  }

  /**
   * Remove session from all maps
   */
  private removeSession(sessionId: string, expectedSession?: Session): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || (expectedSession && session !== expectedSession)) {
      return false;
    }
    this.deviceSessionMap.delete(session.assignedDevice);
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
      const deviceId = session?.assignedDevice;
      this.removeSession(sessionId);
      // Notify release callbacks so session-scoped state is cleaned up
      if (deviceId) {
        void this.getBarrier()
          .track(() => this.deviceSessionRepository.markReleased(sessionId, "expired", this.timer.now(), "cleanup-expired"))
          .catch(error => logger.warn(`[SessionManager] Failed to mark session released (cleanup-expired): ${error}`));
        for (const callback of this.releaseCallbacks) {
          try {
            callback(sessionId, deviceId);
          } catch (error) {
            logger.warn(`Session cleanup callback failed for ${sessionId}: ${error}`);
          }
        }
      }
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
