import { ListChangedBroadcaster } from "../listChangedBroadcast";
import type { ObserveResult } from "../../models/ObserveResult";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import {
  type KeepAwakeRestoreReport,
  type KeepScreenAwakeState,
} from "../../utils/KeepScreenAwakeManager";
import { logger } from "../../utils/logger";
import { deviceReadinessRank, type DeviceReadinessLevel } from "../readiness/DeviceReadiness";
import { SessionDeviceStateRestore } from "../sessionDeviceStateRestore";
import {
  type BiometricEnrollmentSessionState,
  type ClockSessionState,
  type DeviceLabelMap,
  type NetworkConditionSessionState,
  type RotationSessionState,
  type ScreenReaderSessionState,
  type Session,
  type SessionCacheData,
} from "../sessionManager";

export interface SessionCacheHost {
  findSession(sessionId: string): Session | null;
  updateSessionCache(sessionId: string, updates: Partial<SessionCacheData>): void;
  sessionNow(): number;
  getDeviceReadiness(sessionId: string): DeviceReadinessLevel | undefined;
  getSessionForDevice(deviceId: string): string | null;
  invalidateAutomationReadiness(sessionId: string, reason: string): void;
  readonly stateRestore: Pick<
    SessionDeviceStateRestore,
    | "getKeepAwakeRestoreReport"
    | "trackClockSessionSetup"
    | "runClockMutationExclusive"
    | "trackRotationSessionSetup"
    | "runRotationMutationExclusive"
    | "trackScreenReaderSessionSetup"
    | "runScreenReaderMutationExclusive"
    | "bumpNetworkConditionGeneration"
    | "runNetworkConditionMutationExclusive"
  >;
  getBiometricEnrollment(sessionId: string): BiometricEnrollmentSessionState | undefined;
  getNetworkCondition(sessionId: string): NetworkConditionSessionState | undefined;
  peekSession(sessionId: string): Session | null;
}

export class SessionCache {
  constructor(private readonly host: SessionCacheHost) {}

  /**
   * Update session cache data
   *
   * Allows tools to store data (screenshots, hierarchies) that can be
   * reused by other tools in the same session without re-fetching.
   *
   * Cache data only: this never touches the session's activity or liveness clocks (#10703). It is
   * reached from paths that are not the owner's tool usage — a device incarnation change
   * resetting readiness, or an observe by device id from any client invalidating it — so stamping
   * `lastUsedAt` here would let them extend the owner's idle window and make `session-info`'s
   * `lastUsedAt` stop meaning "last tool call". A tool call's activity is stamped where the call is
   * admitted (`getOrCreateSession`) and where it ends (`recordToolCallEnded`).
   */
  updateSessionCache(sessionId: string, updates: Partial<SessionCacheData>): void {
    const session = this.host.findSession(sessionId);
    if (!session) {
      logger.warn(`Cannot update cache for session ${sessionId}: not found`);
      return;
    }

    session.cacheData = {
      ...session.cacheData,
      ...updates,
    };
    if ("deviceLabels" in updates) {
      ListChangedBroadcaster.emit("tools");
    }
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
    this.host.updateSessionCache(sessionId, {
      lastHierarchy: hierarchy,
      lastObserveTime: this.host.sessionNow(),
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
  setLastRenderedObservation(
    sessionId: string,
    observation: ObserveResult,
    displayRevision?: number,
  ): void {
    this.host.updateSessionCache(sessionId, {
      lastRenderedObservation: observation,
      lastRenderedDisplayGeneration: observation.display?.generation,
      lastRenderedDisplayKey: observation.display?.key,
      ...(displayRevision === undefined ? {} : { lastRenderedDisplayRevision: displayRevision }),
    });
  }

  /** Session cache owns this output-only state, so release/rebind clears it with the session. */
  getLastActionMetadata(
    sessionId: string,
    deviceId: string,
  ): Readonly<Record<string, unknown>> | undefined {
    const record = this.host.findSession(sessionId)?.cacheData.lastActionMetadata;
    return record?.deviceId === deviceId ? record.blocks : undefined;
  }

  setLastActionMetadata(
    sessionId: string,
    deviceId: string,
    blocks: Record<string, unknown>,
  ): void {
    this.host.updateSessionCache(sessionId, { lastActionMetadata: { deviceId, blocks } });
  }

  /**
   * Read the diff baseline (`lastRenderedObservation`) without recording session
   * activity (issue #3053). The `--actions-diff-observe` baseline store reads the
   * baseline on every non-observe action; routing that read through
   * `getSessionCache` would fire a second `recordActivity` UPDATE on top of the
   * `set` that follows (get + set = two fire-and-forget writes per diffed action).
   * This reader uses `findSession`, which neither records activity nor releases an expired
   * session, so a diffed action records activity once — from the baseline `set` — not twice.
   * Returns `undefined` for an unknown/expired session or when no observation has
   * been rendered yet.
   */
  getLastRenderedObservation(sessionId: string): ObserveResult | undefined {
    return this.host.findSession(sessionId)?.cacheData.lastRenderedObservation;
  }

  /** Keep the caller's revision even when a fold clears the hierarchy and diff baseline. */
  setLastRenderedDisplayRevision(
    sessionId: string,
    revision: number,
    key?: string,
    generation?: number,
  ): void {
    this.host.updateSessionCache(sessionId, {
      lastRenderedDisplayRevision: revision,
      lastRenderedDisplayGeneration: generation,
      ...(key === undefined ? {} : { lastRenderedDisplayKey: key }),
    });
  }

  getLastRenderedDisplayGeneration(sessionId: string): number | undefined {
    return this.host.findSession(sessionId)?.cacheData.lastRenderedDisplayGeneration;
  }

  setDisplayPin(sessionId: string, pin: string | null): void {
    this.host.updateSessionCache(sessionId, { displayPin: pin ?? undefined });
    if (pin === null) {
      const session = this.host.findSession(sessionId);
      if (session) {
        delete session.cacheData.displayPin;
      }
    }
  }

  getDisplayPin(sessionId: string): string | undefined {
    return this.host.findSession(sessionId)?.cacheData.displayPin;
  }

  getLastRenderedDisplayKey(sessionId: string): string | undefined {
    return this.host.findSession(sessionId)?.cacheData.lastRenderedDisplayKey;
  }

  getLastRenderedDisplayRevision(sessionId: string): number | undefined {
    return this.host.findSession(sessionId)?.cacheData.lastRenderedDisplayRevision;
  }

  /**
   * Read the keep-awake state without recording session activity (mirrors
   * `getLastRenderedObservation`, issue #3053): this is a best-effort setup/restore
   * read, not a tool interaction, so it must not fire a session-activity write.
   * Returns `undefined` for an unknown/expired session or before setup ran.
   */
  getKeepScreenAwake(sessionId: string): KeepScreenAwakeState | undefined {
    return this.host.findSession(sessionId)?.cacheData.keepScreenAwake;
  }

  /**
   * Record the highest {@link DeviceReadinessLevel} actually achieved for a
   * session (#6227). Mirrors `setKeepScreenAwake`'s typed-slot pattern so a
   * later call reusing the same session UUID can detect an upgrade is needed
   * (e.g. a prior `booted`-only call left CtrlProxy setup unprepared) rather
   * than trusting `existingSession` alone.
   *
   * MONOTONIC by achieved level (#6227 round 7): only ever RAISES the
   * recorded level, never lowers it. `bindOrReuseDeviceSession` can hand back
   * a live session already bound to the exact requested device — a session
   * that previously reached `automationReady` through one acquisition path.
   * A later, less-demanding acquisition on that same session (e.g.
   * `provisionDevice({ readiness: "none" })`, or the `booted`-only branch of
   * `ensureReadinessUpgraded`) would otherwise overwrite that recorded level
   * with `"booted"`, silently downgrading it — a later `automationReady` tool
   * would then trust the stale `booted` record and skip CtrlProxy/
   * accessibility-service setup the device still needs, or an unnecessary
   * redundant setup would run. Comparing against the currently recorded level
   * and only writing when the new one is higher (or none has been recorded
   * yet) closes that hole. A genuine loss of automation readiness uses
   * `invalidateAutomationReadiness` instead of repurposing this recorder.
   */
  setDeviceReadiness(sessionId: string, level: DeviceReadinessLevel): void {
    const current = this.host.getDeviceReadiness(sessionId);
    if (current !== undefined && deviceReadinessRank(current) >= deviceReadinessRank(level)) {
      return;
    }
    this.host.updateSessionCache(sessionId, { deviceReadiness: level });
  }

  /**
   * Read the achieved readiness level without recording session activity
   * (mirrors `getKeepScreenAwake`). Returns `undefined` for an unknown/expired
   * session or before any setup has recorded a level.
   */
  getDeviceReadiness(sessionId: string): DeviceReadinessLevel | undefined {
    return this.host.findSession(sessionId)?.cacheData.deviceReadiness;
  }

  /** Drop stale automation readiness after its service becomes unavailable. */
  invalidateAutomationReadiness(sessionId: string, reason: string): void {
    if (!this.host.findSession(sessionId)) {
      logger.debug(`[SessionManager] Cannot invalidate readiness for unknown session ${sessionId}`);
      return;
    }
    logger.warn(`[SessionManager] Invalidating automation readiness for ${sessionId}: ${reason}`);
    this.host.updateSessionCache(sessionId, { deviceReadiness: "booted" });
  }

  /** Invalidate the session currently owning a device after an embedded hierarchy read fails. */
  invalidateAutomationReadinessForDevice(deviceId: string, reason: string): void {
    const sessionId = this.host.getSessionForDevice(deviceId);
    if (sessionId) {
      this.host.invalidateAutomationReadiness(sessionId, reason);
    }
  }

  /**
   * Drop a restored guest's automation proof without using the monotonic setter.
   * The next device-aware request must rerun runner/accessibility readiness.
   */
  resetDeviceReadinessForDevice(deviceId: string): void {
    const sessionId = this.host.getSessionForDevice(deviceId);
    if (!sessionId) {
      return;
    }
    this.host.updateSessionCache(sessionId, { deviceReadiness: "booted" });
  }

  setClock(session: Session, state: ClockSessionState): void {
    session.cacheData.clock ??= state;
  }

  getClock(sessionId: string): ClockSessionState | undefined {
    return this.host.findSession(sessionId)?.cacheData.clock;
  }

  getKeepAwakeRestoreReport(sessionId: string): KeepAwakeRestoreReport | undefined {
    return this.host.stateRestore.getKeepAwakeRestoreReport(sessionId);
  }

  /** Tracked setup retains this exact session even after a bounded release times out. */
  trackClockSessionSetup(session: Session, createSetup: () => Promise<void>): Promise<void> {
    return this.host.stateRestore.trackClockSessionSetup(session, createSetup);
  }

  runClockMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.host.stateRestore.runClockMutationExclusive(sessionId, fn);
  }

  setRotation(session: Session, state: RotationSessionState): void {
    session.cacheData.rotation ??= state;
  }

  getRotation(sessionId: string): RotationSessionState | undefined {
    return this.host.findSession(sessionId)?.cacheData.rotation;
  }

  trackRotationSessionSetup(
    session: Session,
    createSetup: (assertCurrentDevice: () => void) => Promise<void>,
  ): Promise<void> {
    return this.host.stateRestore.trackRotationSessionSetup(session, createSetup);
  }

  runRotationMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.host.stateRestore.runRotationMutationExclusive(sessionId, fn);
  }

  /** Tracked setup retains this exact session even after a bounded release times out (#10146). */
  trackScreenReaderSessionSetup(
    session: Session,
    createSetup: (assertCurrentDevice: () => void) => Promise<void>,
  ): Promise<void> {
    return this.host.stateRestore.trackScreenReaderSessionSetup(session, createSetup);
  }

  /** Write-once: the first toggle's pre-change state is the one release restores. */
  setScreenReader(session: Session, state: ScreenReaderSessionState): void {
    session.cacheData.screenReader ??= state;
  }

  getScreenReader(sessionId: string): ScreenReaderSessionState | undefined {
    return this.host.findSession(sessionId)?.cacheData.screenReader;
  }

  runScreenReaderMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.host.stateRestore.runScreenReaderMutationExclusive(sessionId, fn);
  }

  /**
   * Preserve the pre-session iOS Simulator enrollment state. This setter is
   * intentionally write-once per session: every later enrollment change must
   * restore the same state the session first observed.
   */
  setBiometricEnrollment(sessionId: string, state: BiometricEnrollmentSessionState): void {
    if (this.host.getBiometricEnrollment(sessionId)) {
      return;
    }
    this.host.updateSessionCache(sessionId, { biometricEnrollment: state });
  }

  /** Read the original enrollment state without recording session activity. */
  getBiometricEnrollment(sessionId: string): BiometricEnrollmentSessionState | undefined {
    return this.host.findSession(sessionId)?.cacheData.biometricEnrollment;
  }

  /**
   * Record that a session degraded the device-wide network condition (issue
   * #6012), preserving the pre-session baseline to restore on release. Write-once
   * per session: the first degrade wins, so release always restores the same
   * baseline the session first observed.
   */
  setNetworkCondition(sessionId: string, state: NetworkConditionSessionState): void {
    if (this.host.getNetworkCondition(sessionId)) {
      return;
    }
    this.host.updateSessionCache(sessionId, { networkCondition: state });
  }

  /** Bump the per-session network-condition generation (issue #6177); see {@link SessionDeviceStateRestore}. */
  bumpNetworkConditionGeneration(sessionId: string): number {
    return this.host.stateRestore.bumpNetworkConditionGeneration(sessionId);
  }

  /** Per-session mutex over a whole networkCondition mutation (issue #6178). */
  runNetworkConditionMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.host.stateRestore.runNetworkConditionMutationExclusive(sessionId, fn);
  }

  /** Read the original network condition without recording session activity. */
  getNetworkCondition(sessionId: string): NetworkConditionSessionState | undefined {
    return this.host.findSession(sessionId)?.cacheData.networkCondition;
  }

  /**
   * Read the device-label map without recording session activity (issue #3053):
   * label routing reads this on every `device:`-labelled request, so it must not
   * fire a session-activity write per read. Returns `undefined` for an
   * unknown/expired session or a session with no registered labels.
   *
   * It releases nothing either (#11640): every route from a label to its base reads this map, so
   * a session past its idle deadline publishes no labels and is left to the scan, or to a call
   * that names it, to release.
   */
  getDeviceLabels(sessionId: string): DeviceLabelMap | undefined {
    return this.host.peekSession(sessionId)?.cacheData.deviceLabels;
  }

  /**
   * Get session cache data. A read: it records no activity (#10703), like the typed getters.
   */
  getSessionCache(sessionId: string): SessionCacheData | null {
    return this.host.findSession(sessionId)?.cacheData ?? null;
  }

  /**
   * Clear session cache (for specific key or all)
   */
  clearSessionCache(sessionId: string, key?: string): void {
    const session = this.host.findSession(sessionId);
    if (!session) {
      return;
    }

    if (key) {
      delete session.cacheData[key as keyof SessionCacheData];
    } else {
      // Observation-cache invalidation must not clear a deliberate session selection.
      session.cacheData =
        session.cacheData.displayPin === undefined
          ? {}
          : { displayPin: session.cacheData.displayPin };
    }

    if (!key || key === "deviceLabels") {
      ListChangedBroadcaster.emit("tools");
    }
    logger.debug(`Cleared cache for session ${sessionId}${key ? ` (key: ${key})` : " (all)"}`);
  }
}
