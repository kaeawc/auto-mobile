import { z } from "zod";

export const SESSION_CLEANUP_RECEIPT_METHOD = "daemon/sessionCleanupReceipt";
export const COMPLETED_CLEANUP_RECEIPT_LIMIT = 256;

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
 * or changes admission. A fulfilled best-effort promise is not evidence of success.
 */
export class SessionCleanupReceipts {
  private generation: string | undefined;
  private readonly records = new Map<string, ReceiptRecord>();
  private readonly completed = new Map<string, ReceiptRecord>();

  constructor(private readonly completedLimit = COMPLETED_CLEANUP_RECEIPT_LIMIT) {}

  setGeneration(generation: string): void {
    if (this.generation === generation) {
      return;
    }
    this.generation = generation;
    this.records.clear();
    this.completed.clear();
  }

  getGeneration(): string | undefined {
    return this.generation;
  }

  bind(binding: Binding, recovered: boolean = false): void {
    const previous = this.records.get(binding.sessionId);
    if (previous?.binding.deref() === binding) {
      return;
    }
    this.completed.delete(binding.sessionId);
    this.records.set(binding.sessionId, {
      binding: new WeakRef(binding),
      sessionId: binding.sessionId,
      deviceId: binding.assignedDevice,
      releasing: false,
      releaseSettled: false,
      poolSettled: false,
      poolReleased: false,
      pending: 0,
      ...(previous || recovered ? { unknown: "recovered_or_reused_session" } : {}),
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
      this.completed.delete(binding.sessionId);
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
    const record = this.records.get(sessionId);
    if (record) {
      record.failure ??= reason;
    }
  }

  invalidate(sessionId: string, reason: string): void {
    const record = this.records.get(sessionId);
    if (record) {
      record.unknown ??= reason;
    }
  }

  /** Capture identity now; a late completion must never update a replacement binding. */
  track(sessionId: string, work: Promise<unknown>): void {
    const record = this.records.get(sessionId);
    if (!record) {
      return;
    }
    record.pending++;
    this.completed.delete(sessionId);
    void work.then(
      () => this.settle(record),
      () => {
        record.failure ??= "cleanup_rejected";
        this.settle(record);
      },
    );
  }

  trackDevice(deviceId: string, work: Promise<unknown>, unverified: boolean = false): void {
    for (const record of this.records.values()) {
      if (record.deviceId !== deviceId || this.completed.has(record.sessionId)) {
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
      if (record.deviceId === deviceId && !this.completed.has(record.sessionId)) {
        record.failure ??= reason;
      }
    }
  }

  invalidateDevice(deviceId: string, reason: string): void {
    for (const record of this.records.values()) {
      if (record.deviceId === deviceId && !this.completed.has(record.sessionId)) {
        record.unknown ??= reason;
      }
    }
  }

  poolReleased(sessionId: string, deviceId: string): void {
    const record = this.records.get(sessionId);
    if (record?.deviceId === deviceId && record.releasing) {
      record.poolSettled = true;
      record.poolReleased = true;
      this.retainCompleted(record);
    }
  }

  poolReleaseUnconfirmed(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (record && !record.poolReleased) {
      record.unknown ??= "pool_ownership_changed";
      record.poolSettled = true;
      this.retainCompleted(record);
    }
  }

  poolReleaseFailed(sessionId: string): void {
    const record = this.records.get(sessionId);
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
    const record = this.records.get(binding.sessionId);
    return record?.binding.deref() === binding ? record : undefined;
  }

  private settle(record: ReceiptRecord): void {
    record.pending--;
    this.retainCompleted(record);
  }

  private retainCompleted(record: ReceiptRecord): void {
    const sessionId = record.sessionId;
    if (
      this.records.get(sessionId) !== record ||
      !record.releaseSettled ||
      !record.poolSettled ||
      record.pending > 0
    ) {
      return;
    }
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
