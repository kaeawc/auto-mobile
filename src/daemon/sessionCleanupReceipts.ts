import { z } from "zod";

export const SESSION_CLEANUP_RECEIPT_METHOD = "daemon/sessionCleanupReceipt";
export const COMPLETED_CLEANUP_RECEIPT_LIMIT = 256;
export const UNCOMPLETED_CLEANUP_RECEIPT_LIMIT = 1024;
export const CLEANUP_RECEIPT_TOMBSTONE_LIMIT = 4096;

export const sessionCleanupReceiptParams = z.object({
  sessionUuid: z.string().uuid(),
  deviceId: z.string().min(1).max(256),
  daemonGeneration: z.string().min(1).max(128),
});

export type SessionCleanupIdentity = z.infer<typeof sessionCleanupReceiptParams>;
export type SessionCleanupReceipt = SessionCleanupIdentity & {
  state: "pending" | "succeeded" | "failed" | "unknown";
  reason: string;
};

interface Binding {
  sessionId: string;
  assignedDevice: string;
  platform: "android" | "ios";
}

// This is a restore owner, not a device binding; ownerless startup work has no receipt.
export interface CleanupReceiptOwner {
  readonly sessionId?: string;
}

export interface CleanupReceiptRecorder {
  bind(binding: Binding, recovered?: boolean): void;
  begin(binding: Binding, options?: { executionsJoined?: boolean; terminal?: boolean }): void;
  finish(binding: Binding, releasedDevice: string | null): void;
  fail(sessionId: string, reason: string): void;
  failOwner(owner: CleanupReceiptOwner, reason: string): void;
  invalidate(sessionId: string, reason: string): void;
  track(sessionId: string, work: Promise<unknown>): void;
  trackOwner(owner: CleanupReceiptOwner, work: Promise<unknown>): void;
  trackDevice(deviceId: string, work: Promise<unknown>, unverified?: boolean): void;
  failDevice(deviceId: string, reason: string): void;
  invalidateDevice(deviceId: string, reason: string): void;
}

interface ReceiptRecord {
  // History must not retain the session's screenshots, hierarchy, or other caches.
  binding: WeakRef<Binding>;
  sessionId: string;
  deviceId: string;
  releasing: boolean;
  releaseSettled: boolean;
  poolSettled: boolean;
  poolReleased: boolean;
  pending: number;
  failure?: string;
  unknown?: string;
}

/**
 * Evidence for one daemon lifetime only. Reading never starts work, refreshes history,
 * or changes admission: a fulfilled promise is necessary, not sufficient, for success.
 * Recorder methods only update in-memory bookkeeping and observe native promises; they do not throw.
 */
export class SessionCleanupReceipts implements CleanupReceiptRecorder {
  private generation: string | undefined;
  private readonly records = new Map<string, ReceiptRecord>();
  private readonly completed = new Map<string, ReceiptRecord>();

  private readonly uncompleted = new Map<string, ReceiptRecord>();
  private readonly tombstones = new Set<string>();

  constructor(
    private readonly completedLimit = COMPLETED_CLEANUP_RECEIPT_LIMIT,
    private readonly uncompletedLimit = UNCOMPLETED_CLEANUP_RECEIPT_LIMIT,
    private readonly tombstoneLimit = CLEANUP_RECEIPT_TOMBSTONE_LIMIT,
  ) {}

  setGeneration(generation: string): void {
    if (this.generation === generation) {
      return;
    }
    this.generation = generation;
    this.records.clear();
    this.completed.clear();
    this.uncompleted.clear();
    this.tombstones.clear();
  }

  getGeneration(): string | undefined {
    return this.generation;
  }

  bind(binding: Binding, recovered: boolean = false): void {
    const previous = this.records.get(binding.sessionId);
    if (previous?.binding.deref() === binding) {
      return;
    }
    const reused = this.tombstones.has(binding.sessionId);
    this.tombstones.add(binding.sessionId);
    if (this.tombstones.size > this.tombstoneLimit) {
      this.tombstones.delete(this.tombstones.values().next().value!);
    }
    this.completed.delete(binding.sessionId);
    this.uncompleted.delete(binding.sessionId);
    this.records.set(binding.sessionId, {
      binding: new WeakRef(binding),
      sessionId: binding.sessionId,
      deviceId: binding.assignedDevice,
      releasing: false,
      releaseSettled: false,
      poolSettled: false,
      poolReleased: false,
      pending: 0,
      ...(previous || recovered || reused ? { unknown: "recovered_or_reused_session" } : {}),
      // Android has background sampling whose stop currently signals cancellation
      // without joining its device commands. This receipt is qualified for iOS only.
      ...(binding.platform !== "ios" ? { unknown: "platform_not_qualified" } : {}),
    });
  }

  begin(binding: Binding, options: { executionsJoined?: boolean; terminal?: boolean } = {}): void {
    const record = this.forBinding(binding);
    if (record) {
      record.releasing = true;
      record.releaseSettled = false;
      record.poolSettled = false;
      record.poolReleased = false;
      if (options.executionsJoined === false) {
        record.unknown ??= "executions_not_joined_before_release";
      }
      if (options.terminal === false) {
        record.unknown ??= "nonterminal_release";
      }
      this.uncompleted.delete(binding.sessionId);
    }
  }

  finish(binding: Binding, releasedDevice: string | null): void {
    const record = this.forBinding(binding);
    if (!record) {
      return;
    }
    record.releaseSettled = true;
    if (releasedDevice !== record.deviceId) {
      record.unknown ??= "release_not_committed";
    }
    this.retainCompleted(record);
  }

  fail(sessionId: string, reason: string): void {
    const record = this.mutableRecord(sessionId);
    if (record && (!record.failure || record.failure === "cleanup_rejected")) {
      // Only cleanup_rejected is refined: reasons are diagnostic and the failed state never changes.
      record.failure = reason;
      this.retainCompleted(record);
    }
  }

  failOwner(owner: CleanupReceiptOwner, reason: string): void {
    if (owner.sessionId !== undefined) {
      this.fail(owner.sessionId, reason);
    }
  }

  invalidate(sessionId: string, reason: string): void {
    const record = this.mutableRecord(sessionId);
    if (record) {
      record.unknown ??= reason;
      this.retainCompleted(record);
    }
  }

  /** Capture identity now; a late completion must never update a replacement binding. */
  track(sessionId: string, work: Promise<unknown>): void {
    const record = this.mutableRecord(sessionId);
    if (!record) {
      return;
    }
    record.pending++;
    void work.then(
      () => this.settle(record),
      () => {
        if (this.mutableRecord(sessionId) === record) {
          record.failure ??= "cleanup_rejected";
        }
        this.settle(record);
      },
    );
    this.retainCompleted(record);
  }

  trackOwner(owner: CleanupReceiptOwner, work: Promise<unknown>): void {
    if (owner.sessionId !== undefined) {
      this.track(owner.sessionId, work);
    }
  }

  trackDevice(deviceId: string, work: Promise<unknown>, unverified: boolean = false): void {
    for (const record of this.records.values()) {
      if (
        !record.releasing ||
        record.deviceId !== deviceId ||
        this.completed.has(record.sessionId)
      ) {
        continue;
      }
      if (unverified) {
        record.unknown ??= "unverified_external_cleanup";
      }
      this.track(record.sessionId, work);
    }
  }

  failDevice(deviceId: string, reason: string): void {
    for (const record of this.records.values()) {
      if (
        record.releasing &&
        record.deviceId === deviceId &&
        !this.completed.has(record.sessionId)
      ) {
        this.fail(record.sessionId, reason);
      }
    }
  }

  invalidateDevice(deviceId: string, reason: string): void {
    for (const record of this.records.values()) {
      if (
        record.releasing &&
        record.deviceId === deviceId &&
        !this.completed.has(record.sessionId)
      ) {
        this.invalidate(record.sessionId, reason);
      }
    }
  }

  poolReleased(sessionId: string, deviceId: string): void {
    const record = this.mutableRecord(sessionId);
    if (record?.deviceId === deviceId && record.releasing) {
      record.poolSettled = true;
      record.poolReleased = true;
      this.retainCompleted(record);
    }
  }

  poolReleaseUnconfirmed(sessionId: string): void {
    const record = this.mutableRecord(sessionId);
    if (record && !record.poolSettled) {
      record.unknown ??= "pool_ownership_changed";
      record.poolSettled = true;
      this.retainCompleted(record);
    }
  }

  poolReleaseFailed(sessionId: string): void {
    const record = this.mutableRecord(sessionId);
    if (record) {
      record.failure ??= "pool_release_failed";
      record.poolSettled = true;
      this.retainCompleted(record);
    }
  }

  query(identity: SessionCleanupIdentity): SessionCleanupReceipt {
    const result = (state: SessionCleanupReceipt["state"], reason: string) => ({
      ...identity,
      state,
      reason,
    });
    if (!this.generation || identity.daemonGeneration !== this.generation) {
      return result("unknown", "daemon_generation_mismatch");
    }
    const record = this.records.get(identity.sessionUuid);
    if (!record || record.deviceId !== identity.deviceId) {
      return result("unknown", "no_matching_history");
    }
    if (record.failure) {
      return result("failed", record.failure);
    }
    if (record.unknown) {
      return result("unknown", record.unknown);
    }
    if (!record.releasing) {
      return result("pending", "session_active");
    }
    if (!record.releaseSettled || record.pending > 0) {
      return result("pending", "teardown_in_progress");
    }
    if (!record.poolReleased) {
      return result("pending", "pool_release_incomplete");
    }
    return result("succeeded", "cleanup_completed");
  }

  private forBinding(binding: Binding): ReceiptRecord | undefined {
    const record = this.mutableRecord(binding.sessionId);
    return record?.binding.deref() === binding ? record : undefined;
  }

  private mutableRecord(sessionId: string): ReceiptRecord | undefined {
    return this.completed.has(sessionId) ? undefined : this.records.get(sessionId);
  }

  private settle(record: ReceiptRecord): void {
    if (this.mutableRecord(record.sessionId) !== record) {
      return;
    }
    record.pending--;
    this.retainCompleted(record);
  }

  private retainCompleted(record: ReceiptRecord): void {
    const sessionId = record.sessionId;
    if (this.mutableRecord(sessionId) !== record || !record.releaseSettled) {
      return;
    }
    // Unknown cannot become success; failed original work stays visible until settled or capped.
    const terminalUnknown = record.unknown && !record.failure;
    if (!terminalUnknown && (record.pending > 0 || (!record.poolSettled && !record.unknown))) {
      this.uncompleted.set(sessionId, record);
      while (this.uncompleted.size > this.uncompletedLimit) {
        const oldest = this.uncompleted.keys().next().value!;
        this.uncompleted.delete(oldest);
        this.records.delete(oldest);
      }
      return;
    }
    this.uncompleted.delete(sessionId);
    this.completed.set(sessionId, record);
    while (this.completed.size > this.completedLimit) {
      const oldest = this.completed.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.completed.delete(oldest);
      this.records.delete(oldest);
    }
  }
}
