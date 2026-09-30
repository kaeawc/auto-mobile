import type { DeviceInfo } from "../models";
import type { Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { toActionableError } from "../models/ActionableError";
import type {
  AndroidRecoveryRecord,
  AndroidRecoveryRecordLedger,
  AndroidRecoveryRecordFinalization,
  AndroidRecoveryReservationKind,
} from "./androidRecoveryRecordLedger";
import type { SessionPreservingRecoveryResult } from "./devicePool";

export interface SessionPreservingRecovery {
  promise: Promise<SessionPreservingRecoveryResult>;
  incidentId?: string;
}

const RECOVERING_IMAGE_SETTLEMENT_MISSING_RETRY_MS = 250;

interface RecoveringAndroidImageSettlement {
  settled: Promise<void>;
  resolve(): void;
}

export interface DeviceRecoveryPoolPort {
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

  constructor(private readonly pool: DeviceRecoveryPoolPort) {}

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
  ): void {
    for (const [deviceId, owner] of this.androidRecoveryHandoffOwners) {
      if (owner === replacementHandoffOwner) {
        this.androidRecoveryHandoffOwners.delete(deviceId);
      }
    }
    const recordOwnsImage = Array.from(this.pool.getRecoveringSessionLosses().values()).some(
      (record) => record.avdName === avdName && record.reservations.has("image"),
    );
    if (!retainRecoveryImage && !recordOwnsImage) {
      this.clearRecoveringAndroidImage(avdName);
    }
    for (const deviceId of recoveryDeviceIds) {
      this.recoveringAndroidDeviceIds.delete(deviceId);
    }
  }

  setRecoveringAndroidImage(avdName: string, image: DeviceInfo): void {
    this.recoveringAndroidImages.set(avdName, image);
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
    let abortListener: (() => void) | undefined;
    const cancellation = signal
      ? new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(signal.reason ?? new Error("Device preparation cancelled"));
          if (signal.aborted) {
            abortListener();
            return;
          }
          signal.addEventListener("abort", abortListener, { once: true });
        })
      : undefined;
    try {
      await Promise.race([Promise.all(settlements), ...(cancellation ? [cancellation] : [])]);
    } finally {
      if (abortListener) {
        signal?.removeEventListener("abort", abortListener);
      }
    }
  }

  private async waitForAndroidRecoveryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await this.pool.getTimer().sleep(delayMs);
      return;
    }
    let abortListener: (() => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(signal.reason ?? new Error("Device preparation cancelled"));
      if (signal.aborted) {
        abortListener();
        return;
      }
      signal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      await Promise.race([this.pool.getTimer().sleep(delayMs), cancellation]);
    } finally {
      if (abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
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
