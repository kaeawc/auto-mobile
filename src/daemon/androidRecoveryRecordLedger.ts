import { exponentialBackoff } from "../utils/Backoff";
import type { Timer } from "../utils/SystemTimer";
import type { PooledDevice } from "./devicePool";
import type { Session } from "./sessionManager";

const FAILED_RELEASE_RETRY_BASE_DELAY_MS = 5_000;
const FAILED_RELEASE_RETRY_BACKOFF_MULTIPLIER = 2;
const FAILED_RELEASE_RETRY_MAX_DELAY_MS = 300_000;
const failedReleaseRetryBackoff = exponentialBackoff({
  initialDelayMs: FAILED_RELEASE_RETRY_BASE_DELAY_MS,
  multiplier: FAILED_RELEASE_RETRY_BACKOFF_MULTIPLIER,
  maxDelayMs: FAILED_RELEASE_RETRY_MAX_DELAY_MS,
});

export type AndroidRecoveryReservationKind =
  | "image"
  | "reset-cohort"
  | "quarantine"
  | "loss"
  | "failed-release";

export interface AndroidRecoveryRecord {
  sessionId: string;
  generation: number;
  deviceId: string;
  expectedDevice?: PooledDevice;
  incidentId?: string;
  preparation?: symbol;
  avdName?: string;
  deferredUntil?: number;
  deferredShutdowns: number;
  failedReleaseAttempts?: number;
  state: "pending" | "deferred" | "released" | "finalized";
  reservations: Set<AndroidRecoveryReservationKind>;
}

export interface AndroidRecoveryRecordPoolPort {
  getDevice(deviceId: string): PooledDevice | null;
  getSession(sessionId: string): Session | null;
  clearAdbResetReservation(record: AndroidRecoveryRecord): void;
}

export interface AndroidRecoveryRecordFinalization {
  record: AndroidRecoveryRecord;
  clearAdbResetReservation(): void;
  finish(): void;
}

export class AndroidRecoveryRecordLedger {
  /** Sessions whose durable terminal release must be retried before unquarantining. */
  readonly failedTerminalRecoveryReleases: Set<string> = new Set();
  /** The canonical recovery record for each session; legacy callers observe this same map. */
  readonly recoveringSessionLosses = new Map<string, AndroidRecoveryRecord>();
  private nextAndroidRecoveryGeneration = 0;

  constructor(
    private readonly pool: AndroidRecoveryRecordPoolPort,
    private readonly timer: Timer,
  ) {}

  startAndroidRecoveryRecord(
    sessionId: string,
    details: Omit<
      Partial<AndroidRecoveryRecord>,
      "sessionId" | "generation" | "state" | "reservations"
    >,
    reservations: readonly AndroidRecoveryReservationKind[],
    replace = false,
  ): AndroidRecoveryRecord {
    let record = this.recoveringSessionLosses.get(sessionId);
    if (!record || replace) {
      record = {
        sessionId,
        generation: ++this.nextAndroidRecoveryGeneration,
        deviceId: details.deviceId ?? "",
        deferredShutdowns: 0,
        state: "pending",
        reservations: new Set(),
      };
      this.recoveringSessionLosses.set(sessionId, record);
    } else {
      // Reusing the record starts a new attempt. The previous attempt's
      // expired deadline must not survive into it: a terminal failure that
      // retains the fence would otherwise stay "due" for every deferred-retry
      // sweep and relaunch recovery instead of waiting for a later durable
      // release. A released record keeps that state so the attempt finalizes.
      record.deferredUntil = undefined;
      if (record.state !== "released") {
        record.state = "pending";
      }
    }
    Object.assign(record, details);
    for (const reservation of reservations) {
      record.reservations.add(reservation);
    }
    return record;
  }

  markAndroidRecoveryRecordReleased(sessionId: string): AndroidRecoveryRecord | undefined {
    const record = this.recoveringSessionLosses.get(sessionId);
    if (record && record.state !== "finalized") {
      record.state = "released";
    }
    return record;
  }

  /**
   * Clears every legacy recovery backing store owned by one record. An expected
   * record makes delayed cohort cleanup harmless when another attempt replaced it.
   */
  finalizeRecoveryRecord(
    sessionId: string,
    expectedRecord?: AndroidRecoveryRecord,
  ): AndroidRecoveryRecordFinalization | undefined {
    const record = this.recoveringSessionLosses.get(sessionId);
    if (!record || (expectedRecord !== undefined && record !== expectedRecord)) {
      return undefined;
    }
    record.state = "finalized";
    return {
      record,
      clearAdbResetReservation: () => this.pool.clearAdbResetReservation(record),
      finish: () => {
        if (record.reservations.has("failed-release")) {
          this.failedTerminalRecoveryReleases.delete(sessionId);
          record.reservations.delete("failed-release");
          record.failedReleaseAttempts = 0;
        }
        this.recoveringSessionLosses.delete(sessionId);
      },
    };
  }

  markAndroidRecoveryReleaseFailure(record: AndroidRecoveryRecord): void {
    record.reservations.add("failed-release");
    this.failedTerminalRecoveryReleases.add(record.sessionId);
    record.failedReleaseAttempts = (record.failedReleaseAttempts ?? 0) + 1;
    record.deferredUntil =
      this.timer.now() + failedReleaseRetryBackoff.delayForAttempt(record.failedReleaseAttempts);
  }
}
