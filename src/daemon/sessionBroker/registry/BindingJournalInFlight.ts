import { logger } from "../../../utils/logger";
import type { BindingDeletionResult } from "../provisioning/reconciler";
import type { BindingJournalEntry } from "./bindingRegistry";
import {
  BINDING_JOURNAL_MAX_ABANDONED_DELETES,
  BINDING_JOURNAL_OVERDUE_DELETE_GRACE_MS,
} from "./bindingJournalSupport";

interface RemovalOperation {
  overdueAtMs?: number;
  abandoned: boolean;
}

/** Entries some code in this process is driving right now; a redrive leaves them alone. */
export class BindingJournalInFlight {
  private readonly ids = new Set<number>();
  private readonly removals = new Map<string, Set<RemovalOperation>>();
  private readonly operations = new WeakMap<Promise<BindingDeletionResult>, RemovalOperation>();
  private readonly warned = new Set<string>();

  /** Callers wait for every native operation, including abandoned ones. */
  hasRemoval(platform: BindingJournalEntry["platform"], stableId: string): boolean {
    return (this.removals.get(JSON.stringify([platform, stableId]))?.size ?? 0) > 0;
  }

  /** Only the journal pass opens the retry gate for overdue native operations. */
  hasRemovalForPass(
    platform: BindingJournalEntry["platform"],
    stableId: string,
    nowMs: number,
  ): boolean {
    const records = this.removals.get(JSON.stringify([platform, stableId]));
    for (const record of records ?? []) {
      if (
        record.overdueAtMs !== undefined &&
        nowMs - record.overdueAtMs >= BINDING_JOURNAL_OVERDUE_DELETE_GRACE_MS
      ) {
        record.abandoned = true;
      }
    }
    return this.removalBlocked(platform, stableId);
  }

  /** Non-mutating fence rechecked by steps and at the native delete chokepoint. */
  removalBlocked(platform: BindingJournalEntry["platform"], stableId: string): boolean {
    const key = JSON.stringify([platform, stableId]);
    const records = this.removals.get(key);
    if (!records) {
      return false;
    }
    const abandoned = [...records].filter((record) => record.abandoned).length;
    if (abandoned >= BINDING_JOURNAL_MAX_ABANDONED_DELETES) {
      if (!this.warned.has(key)) {
        this.warned.add(key);
        logger.warn(
          `[BindingJournal] Removal of '${stableId}' reached the pending abandoned delete bound.`,
        );
      }
      return true;
    }
    return [...records].some((record) => !record.abandoned);
  }

  markRemovalOverdue(operation: Promise<BindingDeletionResult>, nowMs: number): void {
    const record = this.operations.get(operation);
    if (record && record.overdueAtMs === undefined) {
      record.overdueAtMs = nowMs;
    }
  }

  trackRemoval(
    platform: BindingJournalEntry["platform"],
    stableId: string,
    operation: () => Promise<BindingDeletionResult>,
  ): Promise<BindingDeletionResult> {
    const key = JSON.stringify([platform, stableId]);
    const records = this.removals.get(key) ?? new Set<RemovalOperation>();
    const record: RemovalOperation = { abandoned: false };
    records.add(record);
    this.removals.set(key, records);
    const promise = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (record.abandoned) {
          logger.debug(`[BindingJournal] Abandoned removal of '${stableId}' settled late.`);
        }
        records.delete(record);
        this.operations.delete(promise);
        if (records.size === 0) {
          this.removals.delete(key);
        }
        if (
          [...records].filter((pending) => pending.abandoned).length <
          BINDING_JOURNAL_MAX_ABANDONED_DELETES
        ) {
          this.warned.delete(key);
        }
      });
    this.operations.set(promise, record);
    return promise;
  }
  add(id: number): void {
    this.ids.add(id);
  }
  delete(id: number): void {
    this.ids.delete(id);
  }
  has(id: number): boolean {
    return this.ids.has(id);
  }
}
