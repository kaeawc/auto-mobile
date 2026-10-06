import type { DeviceInfo } from "../models";
import type { BootedDeviceDiscovery } from "../devices/deviceUtils";
import type { Timer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { toActionableError } from "../models/ActionableError";
import type {
  AndroidRecoveryRecord,
  AndroidRecoveryRecordLedger,
  AndroidRecoveryRecordFinalization,
  AndroidRecoveryReservationKind,
} from "./androidRecoveryRecordLedger";
import type {
  AndroidEmulatorContinuityDevice,
  IOSSimulatorRecoveryDevice,
  PooledDevice,
  SessionContinuityDevice,
  SessionPreservingRecoveryResult,
  SessionRecoveryPreparation,
} from "./devicePool";
import type { Session } from "./sessionManager";
import type { EmulatorLossIncident } from "./emulatorLossIncident";

export interface SessionPreservingRecovery {
  promise: Promise<SessionPreservingRecoveryResult>;
  incidentId?: string;
}

const RECOVERING_IMAGE_SETTLEMENT_MISSING_RETRY_MS = 250;

interface RecoveringAndroidImageSettlement {
  settled: Promise<void>;
  resolve(): void;
}

/**
 * A sessionless recovery could not confirm the old emulator stopped, and no
 * recovery record owns the reservation. The image stays reserved until a later
 * fresh observation (after any late kill settled) proves the AVD's state.
 */
interface UnconfirmedRecoveringAndroidImage {
  settled: boolean;
  refreshGeneration: number;
  /** Serials the attempt held; an `offline` one is alive, not gone (#10074). */
  deviceIds: readonly string[];
}

export interface DeviceRecoveryPoolPort {
  getRefreshGeneration(): number;
  /**
   * Which of these serials `adb devices` still lists as `offline` rather than
   * absent. Optional like the manager's: without it, absence from the online-only
   * observation is read as gone, the behaviour before #10074.
   */
  getAndroidOfflineDeviceIds?(deviceIds: readonly string[]): Promise<Set<string>>;
  getEmulatorLossIncident(id: string): Promise<EmulatorLossIncident | undefined>;
  completeJoinedEmulatorLossRecovery(
    id: string,
    outcome: "recovered" | "exhausted" | "not-attempted",
    state?: "awaiting-device",
  ): Promise<void>;
  getPooledDevice(id: string): PooledDevice | undefined;
  getSessionForDevice(id: string): string | null | undefined;
  waitForReleasingSession(sessionId: string): Promise<void> | undefined;
  getAndroidSessionPreservingRecoveryTarget(
    id: string,
    expected: PooledDevice | undefined,
  ): { device: AndroidEmulatorContinuityDevice; session: Session } | undefined;
  getSessionPreservingRecoveryTarget(
    id: string,
    expected: PooledDevice | undefined,
  ): { device: SessionContinuityDevice; session: Session } | undefined;
  isIOSSimulatorContinuityDevice(device: PooledDevice): device is IOSSimulatorRecoveryDevice;
  performSessionPreservingRecovery(
    device: SessionContinuityDevice,
    session: Session,
    incident: string | undefined,
  ): Promise<SessionPreservingRecoveryResult>;
  finishEmulatorLossIncident(incident: string | undefined, outcome: "not-attempted"): Promise<void>;
  recoverSessionBoundAndroidDeviceAfterAdbServerReset(
    id: string,
    expected: PooledDevice,
  ): Promise<boolean>;
  releaseAdbServerResetCohortReservations(devices: readonly PooledDevice[]): Promise<void>;
  getRecoveringSessionLosses(): ReadonlyMap<string, AndroidRecoveryRecord>;
  getTimer(): Timer;
  getAndroidRecoveryRecordLedger(): AndroidRecoveryRecordLedger;
  getAdbServerResetQuarantinedSessions(): Set<string>;
  getEmulatorLossRecoverySettlements(): Map<string, Promise<void>>;
  hasReleasedDeviceCapture(sessionId: string): boolean;
  refreshEmulatorLossRecoverySettlement(
    incidentId: string | undefined,
    outcome: "exhausted",
  ): Promise<void>;
  settleEmulatorLossIncident(incidentId: string | undefined): void;
  completeEmulatorLossRecovery(incidentId: string | undefined, outcome: "exhausted"): Promise<void>;
  releaseDisconnectedRecoverySessionWithRetry(
    sessionId: string,
    deviceId: string,
    releaseReason: string,
    attempt: () => Promise<void>,
  ): Promise<void>;
  releaseDevice(deviceId: string, sessionId: string): Promise<unknown>;
}

/** Coordinates recovery records, in-flight work, and image handoffs while the pool retains assignment state. */
export class DeviceRecoveryCoordinator {
  readonly sessionPreservingRecoveries = new Map<string, SessionPreservingRecovery>();
  private get recoveringSessionLosses(): ReadonlyMap<string, AndroidRecoveryRecord> {
    return this.pool.getRecoveringSessionLosses();
  }
  private get failedTerminalRecoveryReleases(): ReadonlySet<string> {
    return this.pool.getAndroidRecoveryRecordLedger().failedTerminalRecoveryReleases;
  }
  readonly recoveringAndroidImages: Map<string, DeviceInfo> = new Map();
  readonly recoveringAndroidDeviceIds: Set<string> = new Set();
  readonly androidRecoveryHandoffOwners = new Map<string, symbol>();
  readonly recoveringAndroidImageSettlements: Map<string, RecoveringAndroidImageSettlement> =
    new Map();

  private readonly unconfirmedRecoveringAndroidImages = new Map<
    string,
    UnconfirmedRecoveringAndroidImage
  >();

  constructor(private readonly pool: DeviceRecoveryPoolPort) {}

  /**
   * Preserve a live Android session while its AutoMobile-owned AVD is restarted.
   * The old connection stays authoritative until the replacement is verified by
   * the recorded AVD name; failed recovery leaves a stable-identity-keyed durable
   * handoff rather than allowing the session to allocate an unrelated device.
   */
  prepareSessionPreservingRecovery(
    deviceId: string,
    expectedDevice?: PooledDevice,
  ): SessionRecoveryPreparation | undefined {
    const target = this.pool.getAndroidSessionPreservingRecoveryTarget(deviceId, expectedDevice);
    const sessionId = target?.session.sessionId;
    if (
      !target ||
      !sessionId ||
      this.sessionPreservingRecoveries.has(sessionId) ||
      this.pool.getAdbServerResetQuarantinedSessions().has(sessionId)
    ) {
      return undefined;
    }
    const token = Symbol("session-recovery-preparation");
    this.startAndroidRecoveryRecord(sessionId, { deviceId: target.device.id, preparation: token }, [
      "quarantine",
      "loss",
    ]);
    return { sessionId, token };
  }

  finishSessionPreservingRecoveryPreparation(
    preparation: SessionRecoveryPreparation | undefined,
  ): void {
    if (!preparation) {
      return;
    }
    const record = this.recoveringSessionLosses.get(preparation.sessionId);
    if (record?.preparation !== preparation.token) {
      return;
    }
    this.finalizeRecoveryRecord(preparation.sessionId, record);
  }

  async recoverSessionBoundAndroidDeviceAfterLoss(
    deviceId: string,
    incidentId?: string,
    expectedDevice?: PooledDevice,
  ): Promise<SessionPreservingRecoveryResult> {
    const candidateSessionId =
      expectedDevice?.sessionId ??
      expectedDevice?.adbServerResetSessionId ??
      this.pool.getSessionForDevice(deviceId);
    if (candidateSessionId) {
      const inFlight = this.sessionPreservingRecoveries.get(candidateSessionId);
      if (inFlight) {
        return await this.joinSessionPreservingRecovery(inFlight, incidentId);
      }
      if (this.pool.getAdbServerResetQuarantinedSessions().has(candidateSessionId)) {
        if (this.shouldDeferSessionLossRecovery(candidateSessionId)) {
          await this.pool.finishEmulatorLossIncident(incidentId, "not-attempted");
          return "deferred";
        }
      }
    }
    const target = this.pool.getAndroidSessionPreservingRecoveryTarget(deviceId, expectedDevice);
    if (!target) {
      await this.finishIncidentAfterSessionRelease(candidateSessionId, incidentId);
      return "not-attempted";
    }
    const { device, session } = target;
    const sessionId = session.sessionId;
    const recovery = this.pool.performSessionPreservingRecovery(device, session, incidentId);
    const entry = { promise: recovery, ...(incidentId ? { incidentId } : {}) };
    this.registerSessionPreservingRecovery(sessionId, entry);
    try {
      return await recovery;
    } finally {
      this.clearSessionPreservingRecoveryIfCurrent(sessionId, entry);
    }
  }

  async recoverSessionBoundDeviceAfterLoss(
    deviceId: string,
    incidentId?: string,
    expectedDevice?: PooledDevice,
  ): Promise<SessionPreservingRecoveryResult> {
    const device = expectedDevice ?? this.pool.getPooledDevice(deviceId);
    return device?.platform === "ios"
      ? await this.recoverSessionBoundIOSSimulatorAfterLoss(deviceId, incidentId, expectedDevice)
      : await this.recoverSessionBoundAndroidDeviceAfterLoss(deviceId, incidentId, expectedDevice);
  }

  /**
   * Preserve an iOS simulator session as a durable stable-UDID handoff. This
   * path never boots the simulator; generic persisted-session recovery waits
   * until discovery reports that same UDID as booted again.
   */
  async recoverSessionBoundIOSSimulatorAfterLoss(
    deviceId: string,
    incidentId?: string,
    expectedDevice?: PooledDevice,
  ): Promise<SessionPreservingRecoveryResult> {
    const candidateSessionId = expectedDevice?.sessionId ?? this.pool.getSessionForDevice(deviceId);
    if (candidateSessionId) {
      const inFlight = this.sessionPreservingRecoveries.get(candidateSessionId);
      if (inFlight) {
        return await this.joinSessionPreservingRecovery(inFlight, incidentId);
      }
    }
    const target = this.pool.getSessionPreservingRecoveryTarget(deviceId, expectedDevice);
    if (!target || !this.pool.isIOSSimulatorContinuityDevice(target.device)) {
      await this.finishIncidentAfterSessionRelease(candidateSessionId, incidentId);
      return "not-attempted";
    }
    const { device, session } = target;
    const recovery = this.pool.performSessionPreservingRecovery(device, session, incidentId);
    const entry = { promise: recovery, ...(incidentId ? { incidentId } : {}) };
    this.registerSessionPreservingRecovery(session.sessionId, entry);
    try {
      return await recovery;
    } finally {
      this.clearSessionPreservingRecoveryIfCurrent(session.sessionId, entry);
    }
  }

  private async finishIncidentAfterSessionRelease(
    sessionId: string | null | undefined,
    incidentId: string | undefined,
  ): Promise<void> {
    if (!sessionId) {
      return;
    }
    // An inadmissible releasing session needs teardown settlement, not device recovery.
    const release = this.pool.waitForReleasingSession(sessionId);
    if (!release) {
      return;
    }
    await release;
    await this.pool.finishEmulatorLossIncident(incidentId, "not-attempted");
  }

  async retryDueDeferredSessionRecoveries(): Promise<void> {
    const dueRecoveries = Array.from(this.recoveringSessionLosses.entries()).filter(
      ([sessionId, loss]) =>
        loss.state === "deferred" &&
        loss.deferredUntil !== undefined &&
        this.pool.getTimer().now() >= loss.deferredUntil &&
        !this.sessionPreservingRecoveries.has(sessionId),
    );
    for (const [sessionId, loss] of dueRecoveries) {
      // The snapshot goes stale while an earlier entry is awaited: another
      // sweep may own this session's recovery by now, and a release that
      // landed during that reboot is finalized by its owner, not here.
      if (
        this.finalizeUnownedReleasedRecoveryRecord(sessionId) ||
        !this.isDueDeferredRecoveryStillCurrent(sessionId, loss)
      ) {
        continue;
      }
      if (loss.expectedDevice) {
        await this.pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
          loss.deviceId,
          loss.expectedDevice,
        );
        await this.pool.releaseAdbServerResetCohortReservations([loss.expectedDevice]);
      } else {
        await this.recoverSessionBoundAndroidDeviceAfterLoss(
          loss.deviceId,
          loss.incidentId,
          this.pool.getPooledDevice(loss.deviceId),
        );
      }
      this.finalizeUnownedReleasedRecoveryRecord(sessionId);
    }
  }

  private isDueDeferredRecoveryStillCurrent(
    sessionId: string,
    snapshot: AndroidRecoveryRecord,
  ): boolean {
    return (
      this.recoveringSessionLosses.get(sessionId) === snapshot &&
      snapshot.state === "deferred" &&
      !this.sessionPreservingRecoveries.has(sessionId)
    );
  }

  async joinSessionPreservingRecovery(
    recovery: SessionPreservingRecovery,
    incidentId: string | undefined,
  ): Promise<SessionPreservingRecoveryResult> {
    let result: SessionPreservingRecoveryResult;
    try {
      result = await recovery.promise;
    } catch (error) {
      if (incidentId) {
        try {
          await this.pool.completeJoinedEmulatorLossRecovery(incidentId, "exhausted");
        } finally {
          this.pool.settleEmulatorLossIncident(incidentId);
        }
      }
      throw error;
    }
    if (incidentId) {
      const primaryIncident = recovery.incidentId
        ? await this.pool.getEmulatorLossIncident(recovery.incidentId)
        : undefined;
      await this.pool.completeJoinedEmulatorLossRecovery(
        incidentId,
        primaryIncident?.recovery.outcome ?? (result === "recovered" ? "recovered" : "exhausted"),
        primaryIncident?.session?.state === "awaiting-device" ? "awaiting-device" : undefined,
      );
      this.pool.settleEmulatorLossIncident(incidentId);
    }
    return result;
  }

  async waitForSessionPreservingRecovery(sessionId: string, incidentId?: string): Promise<boolean> {
    const recovery = this.sessionPreservingRecoveries.get(sessionId);
    if (!recovery) {
      return false;
    }
    await this.joinSessionPreservingRecovery(recovery, incidentId);
    return true;
  }

  registerSessionPreservingRecovery(sessionId: string, entry: SessionPreservingRecovery): void {
    this.sessionPreservingRecoveries.set(sessionId, entry);
  }

  clearSessionPreservingRecoveryIfCurrent(
    sessionId: string,
    entry: SessionPreservingRecovery,
  ): void {
    if (this.sessionPreservingRecoveries.get(sessionId) === entry) {
      this.sessionPreservingRecoveries.delete(sessionId);
    }
  }

  addRecoveringAndroidDeviceId(deviceId: string): void {
    this.recoveringAndroidDeviceIds.add(deviceId);
  }

  setAndroidRecoveryHandoffOwner(deviceId: string, handoffOwner: symbol): void {
    this.androidRecoveryHandoffOwners.set(deviceId, handoffOwner);
  }

  clearAndroidRecoveryHandoffOwnerIfCurrent(deviceId: string, owner: symbol): void {
    if (this.androidRecoveryHandoffOwners.get(deviceId) === owner) {
      this.androidRecoveryHandoffOwners.delete(deviceId);
    }
  }

  finishAndroidRecoveryAttempt(
    avdName: string,
    recoveryDeviceIds: ReadonlySet<string>,
    retainRecoveryImage: boolean,
    replacementHandoffOwner: symbol,
    lateShutdownSettled?: Promise<unknown>,
  ): void {
    for (const [deviceId, owner] of this.androidRecoveryHandoffOwners) {
      if (owner === replacementHandoffOwner) {
        this.androidRecoveryHandoffOwners.delete(deviceId);
      }
    }
    const recordOwnsImage = Array.from(this.pool.getRecoveringSessionLosses().values()).some(
      (record) => record.avdName === avdName && record.reservations.has("image"),
    );
    if (!recordOwnsImage) {
      if (retainRecoveryImage) {
        this.markRecoveringAndroidImageUnconfirmed(avdName, recoveryDeviceIds, lateShutdownSettled);
      } else {
        this.clearRecoveringAndroidImage(avdName);
      }
    }
    for (const deviceId of recoveryDeviceIds) {
      this.recoveringAndroidDeviceIds.delete(deviceId);
    }
  }

  /**
   * Keep the reservation without a record to finalize it: wake startup waiters so
   * they fail fast instead of waiting out their boot budget, and remember the
   * generation after which a fresh observation may lift it.
   */
  private markRecoveringAndroidImageUnconfirmed(
    avdName: string,
    recoveryDeviceIds: ReadonlySet<string>,
    lateShutdownSettled: Promise<unknown> | undefined,
  ): void {
    const entry: UnconfirmedRecoveringAndroidImage = {
      settled: lateShutdownSettled === undefined,
      refreshGeneration: this.pool.getRefreshGeneration(),
      deviceIds: Array.from(recoveryDeviceIds),
    };
    this.unconfirmedRecoveringAndroidImages.set(avdName, entry);
    const settlement = this.recoveringAndroidImageSettlements.get(avdName);
    if (settlement) {
      this.recoveringAndroidImageSettlements.delete(avdName);
      settlement.resolve();
    }
    const noteSettled = (): void => {
      if (this.unconfirmedRecoveringAndroidImages.get(avdName) === entry) {
        entry.settled = true;
        entry.refreshGeneration = this.pool.getRefreshGeneration();
      }
    };
    void lateShutdownSettled?.then(noteSettled, noteSettled);
  }

  /** The first of these AVDs whose recovery reservation is unconfirmed and unowned. */
  findUnconfirmedRecoveringAndroidImage(avdNames: readonly string[]): string | undefined {
    return avdNames.find((avdName) => this.unconfirmedRecoveringAndroidImages.has(avdName));
  }

  /**
   * Lift unconfirmed reservations a later fresh Android observation can decide.
   * Gone: nothing holds the AVD any more. Running: the refresh that carried this
   * observation already pooled it, so the pool owns it again. Ambiguous
   * observations (failed discovery, unresolved identity, duplicate AVD names)
   * keep the reservation, as does an observation that predates the late kill's
   * settlement. The observation is online-only, so an AVD it lacks counts as gone
   * only when none of the attempt's serials is still attached to adb as `offline`
   * (#10074); an unreadable state list keeps the reservation too.
   */
  async liftUnconfirmedRecoveringAndroidImages(
    discovery: BootedDeviceDiscovery,
    refreshGeneration: number,
  ): Promise<void> {
    if (
      this.unconfirmedRecoveringAndroidImages.size === 0 ||
      !discovery.succeededPlatforms.has("android") ||
      discovery.devices.some((device) => device.name.startsWith("Unknown ("))
    ) {
      return;
    }
    const missing: Array<[string, UnconfirmedRecoveringAndroidImage]> = [];
    for (const [avdName, entry] of Array.from(this.unconfirmedRecoveringAndroidImages)) {
      if (!entry.settled || refreshGeneration <= entry.refreshGeneration) {
        continue;
      }
      const running = discovery.devices.filter(
        (device) => device.platform === "android" && device.name === avdName,
      );
      if (running.length > 1) {
        continue;
      }
      if (running.length === 0) {
        missing.push([avdName, entry]);
        continue;
      }
      logger.info(
        `[DevicePool] Android AVD '${avdName}' is still running as ${running[0].deviceId}; lifting its unconfirmed recovery reservation and leaving it with the pool`,
      );
      this.clearRecoveringAndroidImage(avdName);
    }
    for (const [avdName, entry] of missing) {
      if (await this.isAnySerialAttachedOffline(avdName, entry.deviceIds)) {
        continue;
      }
      // The probe awaited: a newer attempt may have re-reserved the AVD or another
      // path may already have lifted it. Only lift the entry this pass decided.
      if (this.unconfirmedRecoveringAndroidImages.get(avdName) !== entry) {
        continue;
      }
      logger.info(
        `[DevicePool] Android AVD '${avdName}' is confirmed stopped; lifting its unconfirmed recovery reservation`,
      );
      this.clearRecoveringAndroidImage(avdName);
    }
  }

  private async isAnySerialAttachedOffline(
    avdName: string,
    deviceIds: readonly string[],
  ): Promise<boolean> {
    const probe = this.pool.getAndroidOfflineDeviceIds?.bind(this.pool);
    if (!probe || deviceIds.length === 0) {
      return false;
    }
    try {
      const offline = await probe(deviceIds);
      if (offline.size > 0) {
        logger.info(
          `[DevicePool] Android AVD '${avdName}' is absent from the booted list but adb still lists ${Array.from(offline).join(", ")} as offline; keeping its unconfirmed recovery reservation`,
        );
      }
      return offline.size > 0;
    } catch (error) {
      // An unreadable state list cannot prove the serial left `adb devices`.
      logger.warn(
        `[DevicePool] adb device-state probe failed while lifting the recovery reservation for '${avdName}': ${errorMessage(error)}`,
        error,
      );
      return true;
    }
  }

  setRecoveringAndroidImage(avdName: string, image: DeviceInfo): void {
    this.recoveringAndroidImages.set(avdName, image);
    // A new attempt owns the reservation again and re-marks it if it also fails.
    this.unconfirmedRecoveringAndroidImages.delete(avdName);
    if (this.recoveringAndroidImageSettlements.has(avdName)) {
      return;
    }
    let resolve!: () => void;
    const settled = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    this.recoveringAndroidImageSettlements.set(avdName, { settled, resolve });
  }

  clearRecoveringAndroidImage(avdName: string): void {
    this.recoveringAndroidImages.delete(avdName);
    this.unconfirmedRecoveringAndroidImages.delete(avdName);
    const settlement = this.recoveringAndroidImageSettlements.get(avdName);
    if (!settlement) {
      return;
    }
    this.recoveringAndroidImageSettlements.delete(avdName);
    settlement.resolve();
  }

  async waitForRecoveringAndroidImages(
    avdNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const settlements = avdNames.flatMap((avdName) => {
      const settlement = this.recoveringAndroidImageSettlements.get(avdName);
      return settlement ? [settlement.settled] : [];
    });
    if (settlements.length === 0) {
      if (!avdNames.some((avdName) => this.recoveringAndroidImages.has(avdName))) {
        return;
      }
      // The maps should be updated together; a short retry safely handles any transient inconsistency.
      logger.debug(
        `[DevicePool] Recovering Android AVD image was observed without a tracked settlement; retrying`,
      );
      await this.waitForAndroidRecoveryDelay(RECOVERING_IMAGE_SETTLEMENT_MISSING_RETRY_MS, signal);
      return;
    }
    await this.waitForRecoverySettlements(settlements, signal);
  }

  async waitForRecoverySettlements(
    settlements: readonly Promise<void>[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (settlements.length === 0) {
      return;
    }
    await raceWithDeadline(Promise.all(settlements), {
      timer: this.pool.getTimer(),
      signal,
      label: "Device preparation",
    });
  }

  private async waitForAndroidRecoveryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await this.pool.getTimer().sleep(delayMs);
      return;
    }
    await raceWithDeadline(this.pool.getTimer().sleep(delayMs), {
      timer: this.pool.getTimer(),
      signal,
      label: "Device preparation delay",
    });
  }

  isAndroidRecoveryHandoffReserved(deviceId: string, allowedOwners?: ReadonlySet<symbol>): boolean {
    const owner = this.androidRecoveryHandoffOwners.get(deviceId);
    return owner !== undefined && !allowedOwners?.has(owner);
  }
  startAndroidRecoveryRecord(
    sessionId: string,
    details: Omit<
      Partial<AndroidRecoveryRecord>,
      "sessionId" | "generation" | "state" | "reservations"
    >,
    reservations: readonly AndroidRecoveryReservationKind[],
    replace = false,
  ): AndroidRecoveryRecord {
    return this.trackAndroidRecoveryQuarantine(
      this.pool
        .getAndroidRecoveryRecordLedger()
        .startAndroidRecoveryRecord(sessionId, details, reservations, replace),
    );
  }

  private trackAndroidRecoveryQuarantine(record: AndroidRecoveryRecord): AndroidRecoveryRecord {
    if (record.reservations.has("quarantine")) {
      this.pool.getAdbServerResetQuarantinedSessions().add(record.sessionId);
    }
    return record;
  }

  private markAndroidRecoveryRecordReleased(sessionId: string): AndroidRecoveryRecord | undefined {
    return this.pool.getAndroidRecoveryRecordLedger().markAndroidRecoveryRecordReleased(sessionId);
  }

  /**
   * Clears every legacy recovery backing store owned by one record. An expected
   * record makes delayed cohort cleanup harmless when another attempt replaced it.
   */
  finalizeRecoveryRecord(sessionId: string, expectedRecord?: AndroidRecoveryRecord): boolean {
    return this.completeAndroidRecoveryRecordFinalization(
      this.pool.getAndroidRecoveryRecordLedger().finalizeRecoveryRecord(sessionId, expectedRecord),
    );
  }

  private completeAndroidRecoveryRecordFinalization(
    finalization: AndroidRecoveryRecordFinalization | undefined,
  ): boolean {
    if (!finalization) {
      return false;
    }
    const { record } = finalization;
    if (record.reservations.has("image") && record.avdName) {
      this.clearRecoveringAndroidImage(record.avdName);
    }
    finalization.clearAdbResetReservation();
    if (record.reservations.has("quarantine")) {
      this.pool.getAdbServerResetQuarantinedSessions().delete(record.sessionId);
    }
    finalization.finish();
    return true;
  }

  markAndroidRecoveryReleaseFailure(record: AndroidRecoveryRecord): void {
    this.pool.getAndroidRecoveryRecordLedger().markAndroidRecoveryReleaseFailure(record);
  }

  async finalizeReleasedRecoveryAfterAwait(
    record: AndroidRecoveryRecord,
    incidentId: string | undefined,
  ): Promise<boolean> {
    if (record.state !== "released") {
      return false;
    }
    this.finalizeRecoveryRecord(record.sessionId, record);
    this.pool.settleEmulatorLossIncident(incidentId);
    return true;
  }

  finalizeReleasedRecoverySession(sessionId: string): void {
    const record = this.markAndroidRecoveryRecordReleased(sessionId);
    if (!record) {
      return;
    }
    if (this.sessionPreservingRecoveries.has(sessionId)) {
      return;
    }
    if (!this.finalizeRecoveryRecord(sessionId, record)) {
      return;
    }
    const refresh = this.refreshReleasedRecoveryIncident(record.incidentId);
    if (record.incidentId) {
      this.pool.getEmulatorLossRecoverySettlements().set(record.incidentId, refresh);
    }
    void refresh;
  }

  private async refreshReleasedRecoveryIncident(incidentId: string | undefined): Promise<void> {
    try {
      await this.pool.refreshEmulatorLossRecoverySettlement(incidentId, "exhausted");
    } catch (error) {
      logger.warn(
        `[DevicePool] Failed to refresh released recovery incident ${incidentId ?? "unknown"}: ${error}`,
        error,
      );
    } finally {
      this.pool.settleEmulatorLossIncident(incidentId);
    }
  }

  async refreshReleasedRecoverySettlementAfterAwait(
    record: AndroidRecoveryRecord,
    incidentId: string | undefined,
  ): Promise<void> {
    if (record.state !== "released") {
      return;
    }
    try {
      await this.pool.refreshEmulatorLossRecoverySettlement(incidentId, "exhausted");
    } catch (error) {
      // Diagnostics persistence is best-effort here: the session is already
      // released, so the caller must still finalize the record and clear its
      // reservations instead of recording a failed terminal release.
      logger.warn(
        `[DevicePool] Failed to refresh released recovery incident ${incidentId ?? "unknown"} for session ${record.sessionId}: ${error}`,
        error,
      );
    }
  }

  /**
   * A release that landed during recovery makes a later cleanup failure a
   * diagnostics problem, not a terminal-release failure: the record is
   * finalized instead of fenced behind `failed-release`.
   */
  async finalizeReleasedRecoveryAfterCleanupFailure(
    record: AndroidRecoveryRecord,
    incidentId: string | undefined,
    cleanupError: unknown,
  ): Promise<boolean> {
    if (!(await this.finalizeReleasedRecoveryAfterAwait(record, incidentId))) {
      return false;
    }
    logger.warn(
      `[DevicePool] Session ${record.sessionId} was released before its recovery cleanup failed; finalized without a terminal release: ${cleanupError}`,
      cleanupError,
    );
    return true;
  }

  /**
   * Finalizes a released record only when no recovery still owns it; an
   * in-flight recovery finalizes its own record once its awaits return.
   */
  finalizeUnownedReleasedRecoveryRecord(sessionId: string): boolean {
    const record = this.recoveringSessionLosses.get(sessionId);
    if (record?.state !== "released" || this.sessionPreservingRecoveries.has(sessionId)) {
      return false;
    }
    return this.finalizeRecoveryRecord(sessionId, record);
  }

  isSessionRecoveryInFlight(sessionId: string): boolean {
    const record = this.recoveringSessionLosses.get(sessionId);
    if (record?.reservations.has("failed-release")) {
      // A retained terminal failure is reaper-eligible only when no promise owns
      // it and its retry deadline is due. Unlike other reservations, no deadline
      // means eligible; a future deadline must still block heartbeat/idle sweeps.
      return (
        this.sessionPreservingRecoveries.has(sessionId) ||
        (record.deferredUntil !== undefined && this.shouldDeferSessionRecovery(sessionId))
      );
    }
    return (
      this.pool.getAdbServerResetQuarantinedSessions().has(sessionId) &&
      (this.sessionPreservingRecoveries.has(sessionId) ||
        this.shouldDeferSessionRecovery(sessionId))
    );
  }

  releaseFailedRecoveryOnExpiry(
    sessionId: string,
    releaseReason: string,
    attempt: () => Promise<string | null>,
  ): Promise<string | null> | undefined {
    const record = this.recoveringSessionLosses.get(sessionId);
    if (!record?.reservations.has("failed-release")) {
      return undefined;
    }
    if (this.isSessionRecoveryInFlight(sessionId)) {
      return Promise.resolve(null);
    }
    // Publish ownership before invoking release so overlapping idle and heartbeat
    // sweeps cannot enter a second retry flight. The continuation avoids recursion
    // through SessionManager's expiry hook and preserves its commit/cancel fences.
    const release = Promise.resolve().then(() =>
      this.retryFailedRecoveryRelease(record, releaseReason, attempt),
    );
    const entry: SessionPreservingRecovery = {
      promise: release.then(() => (record.state === "released" ? "released" : "deferred")),
    };
    this.sessionPreservingRecoveries.set(sessionId, entry);
    return entry.promise
      .then(() => release)
      .finally(() => {
        if (this.sessionPreservingRecoveries.get(sessionId) === entry) {
          this.sessionPreservingRecoveries.delete(sessionId);
        }
        this.finalizeUnownedReleasedRecoveryRecord(sessionId);
      });
  }

  private async retryFailedRecoveryRelease(
    record: AndroidRecoveryRecord,
    releaseReason: string,
    attempt: () => Promise<string | null>,
  ): Promise<string | null> {
    let deviceId: string | null = null;
    try {
      await this.pool.releaseDisconnectedRecoverySessionWithRetry(
        record.sessionId,
        record.deviceId,
        releaseReason,
        async () => {
          deviceId = await attempt();
          // A prior terminal reason overrides cleanup-expired/lazy-expiry in
          // the release notification. Consume that captured device here because
          // idle expiry has no daemon caller to return it after session release.
          if (
            (releaseReason === "cleanup-expired" || releaseReason === "lazy-expiry") &&
            this.pool.hasReleasedDeviceCapture(record.sessionId)
          ) {
            await this.pool.releaseDevice(record.deviceId, record.sessionId);
          }
        },
      );
      return deviceId;
    } catch (error) {
      if (
        this.recoveringSessionLosses.get(record.sessionId) === record &&
        record.state !== "released"
      ) {
        this.markAndroidRecoveryReleaseFailure(record);
      }
      throw toActionableError(
        error,
        `Failed to release recovery-fenced session ${record.sessionId}`,
      );
    }
  }

  shouldDeferSessionLossRecovery(sessionId: string): boolean {
    // A failed terminal release can retry release, never restart recovery.
    return (
      this.failedTerminalRecoveryReleases.has(sessionId) ||
      this.shouldDeferSessionRecovery(sessionId)
    );
  }

  shouldDeferSessionRecovery(sessionId: string): boolean {
    const deferredUntil = this.recoveringSessionLosses.get(sessionId)?.deferredUntil;
    return deferredUntil === undefined || this.pool.getTimer().now() < deferredUntil;
  }
}
