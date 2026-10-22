import type { PowerField, PowerRestoreReceipt, PowerRestoreReport } from "./PowerTypes";

/** What one session changed on a device and the values it replaced. */
export interface SessionPower {
  deviceId: string;
  sessionId: string;
  /** Values read BEFORE the session's first change of each field. */
  baseline: PowerRestoreReceipt;
  /** Fields in the order they were first changed; restore runs in reverse. */
  changed: PowerField[];
  /** The screen was on and this session turned it off. */
  screenSlept?: boolean;
}

/** Release reports kept for late `releaseSession` replies, as for screen-lock reports. */
const MAX_RESTORE_REPORTS = 64;

/**
 * In-memory record of the power state sessions changed (#14084), one per device. Like the
 * other restore registries it is never persisted: a daemon restart loses it, and the restore
 * receipt each write returns is the way back.
 */
export class PowerRegistry {
  private readonly records = new Map<string, SessionPower>();
  private readonly restores = new Map<string, Promise<PowerRestoreReport>>();

  get(deviceId: string): SessionPower | undefined {
    return this.records.get(deviceId);
  }

  /**
   * The record `sessionId` writes through. A record a different session left behind keeps its
   * baseline (the device's true original) and passes to the new owner.
   */
  ensure(deviceId: string, sessionId: string): SessionPower {
    const existing = this.records.get(deviceId);
    if (existing) {
      const adopted: SessionPower = { ...existing, sessionId };
      this.records.set(deviceId, adopted);
      return adopted;
    }
    const created: SessionPower = { deviceId, sessionId, baseline: {}, changed: [] };
    this.records.set(deviceId, created);
    return created;
  }

  forget(deviceId: string): void {
    this.records.delete(deviceId);
  }

  /** Remove and return the device's record when `sessionId` owns it. */
  takeOwnedBy(deviceId: string, sessionId: string): SessionPower | undefined {
    const record = this.records.get(deviceId);
    if (record?.sessionId !== sessionId) {
      return undefined;
    }
    this.records.delete(deviceId);
    return record;
  }

  /** Remember the restore a release started, for that release's result. */
  noteRestore(sessionId: string, restore: Promise<PowerRestoreReport>): void {
    this.restores.delete(sessionId);
    this.restores.set(sessionId, restore);
    if (this.restores.size > MAX_RESTORE_REPORTS) {
      const oldest = this.restores.keys().next().value;
      if (oldest !== undefined) {
        this.restores.delete(oldest);
      }
    }
  }

  restoreReport(sessionId: string): Promise<PowerRestoreReport> | undefined {
    return this.restores.get(sessionId);
  }
}

export const defaultPowerRegistry = new PowerRegistry();
