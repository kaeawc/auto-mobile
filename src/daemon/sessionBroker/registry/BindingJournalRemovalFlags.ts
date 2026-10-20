import { classifySqliteError } from "../../../db/databaseFailureClassification";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import type { Timer } from "../../../utils/SystemTimer";
import type {
  AdvanceBindingJournalInput,
  BindingJournalEntry,
  BindingRegistry,
} from "./bindingRegistry";
import {
  BINDING_JOURNAL_REMOVAL_FLAG_MAX_ATTEMPTS,
  BINDING_JOURNAL_REMOVAL_FLAG_WRITE_BUDGET_MS,
} from "./bindingJournalSupport";
import type { RegistryRetryPacing } from "./registryRetryPacing";

type AdvanceResult = Awaited<ReturnType<BindingRegistry["advanceBindingJournal"]>>;

export interface BindingJournalRemovalFlagDependencies {
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  pacing: Pick<RegistryRetryPacing, "wait" | "delay" | "run" | "noteBlocked">;
  /** Advances the entry on the journal's own transition path (owner stamped, cancellation-aware). */
  advance: (
    entry: BindingJournalEntry,
    input: Omit<AdvanceBindingJournalInput, "owner">,
    signal?: AbortSignal,
  ) => Promise<AdvanceResult>;
}

/**
 * Durable removal intent for journal entries: a removal flag recorded in the registry, bridged by
 * an in-memory intent while the registry is contended so an interrupted cleanup is never adopted.
 */
export class BindingJournalRemovalFlags {
  // Memory bridges registry contention; only an unwritable flag can leave intent lost on death.
  private readonly removalIntents = new Set<number>();

  constructor(private readonly deps: BindingJournalRemovalFlagDependencies) {}

  /** The entry's removal intent is settled (or superseded), so the in-memory bridge can go. */
  clear(entryId: number): void {
    this.removalIntents.delete(entryId);
  }

  removalIntended(entry: BindingJournalEntry): boolean {
    return entry.target.removalRequested === true || this.removalIntents.has(entry.id);
  }

  markRemovalIntended(entry: BindingJournalEntry): void {
    if (!entry.target.removalRequested) {
      this.removalIntents.add(entry.id);
    }
  }

  async requestRemoval(
    entry: BindingJournalEntry,
    options: { deadlineMs?: number; signal?: AbortSignal } = {},
  ): Promise<BindingJournalEntry> {
    if (entry.target.removalRequested) {
      return entry;
    }
    this.markRemovalIntended(entry);
    // Cancellation and an expired deadline only bound retries, never the first durability write.
    const recorded = await this.tryRemovalFlag(entry, new AbortController().signal, true);
    if (recorded) {
      return recorded.kind === "advanced" ? recorded.entry : entry;
    }
    if (options.deadlineMs !== undefined && this.deps.timer.now() >= options.deadlineMs) {
      logger.warn(`[BindingJournal] Removal flag for entry ${entry.id} missed its deadline.`);
      return entry;
    }
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    try {
      return await raceWithDeadline(() => this.retryRemovalFlag(entry, signal), {
        timer: this.deps.timer,
        timeoutMs:
          options.deadlineMs === undefined
            ? undefined
            : Math.max(0, options.deadlineMs - this.deps.timer.now()),
        signal,
        label: `removal flag for entry ${entry.id}`,
        onTimeout: () => controller.abort(),
      });
    } catch (error) {
      if (!signal.aborted) {
        // Preserve non-retryable registry failures for the caller's classification.
        throw error;
      }
      logger.warn(
        `[BindingJournal] Removal flag for entry ${entry.id} interrupted: ${errorMessage(error)}`,
        error,
      );
      return entry;
    }
  }

  private async retryRemovalFlag(
    entry: BindingJournalEntry,
    signal: AbortSignal,
  ): Promise<BindingJournalEntry> {
    for (let attempt = 2; attempt <= BINDING_JOURNAL_REMOVAL_FLAG_MAX_ATTEMPTS; attempt++) {
      signal.throwIfAborted();
      await this.deps.pacing.wait(this.deps.pacing.delay(attempt - 1), signal);
      const recorded = await this.tryRemovalFlag(entry, signal);
      if (recorded) {
        return recorded.kind === "advanced" ? recorded.entry : entry;
      }
    }
    logger.warn(`[BindingJournal] Removal flag for entry ${entry.id} exhausted registry retries.`);
    return entry;
  }

  private async tryRemovalFlag(entry: BindingJournalEntry, signal: AbortSignal, immediate = false) {
    const startedMs = this.deps.timer.now();
    const timeout = new Error(`Removal flag for entry ${entry.id} exceeded its write budget.`);
    try {
      const write = () =>
        this.deps.advance(
          entry,
          {
            expectedPhase: entry.phase,
            phase: entry.phase,
            target: {
              removalRequested: true,
              ...(entry.target.newStableId ? { newStableId: entry.target.newStableId } : {}),
            },
          },
          signal,
        );
      const recorded = await (immediate
        ? raceWithDeadline(write, {
            timer: this.deps.timer,
            timeoutMs: BINDING_JOURNAL_REMOVAL_FLAG_WRITE_BUDGET_MS,
            timeoutError: () => timeout,
            label: `first removal flag write for entry ${entry.id}`,
          })
        : this.deps.pacing.run(write, (result) => result.kind === "advanced", signal));
      if (recorded.kind === "advanced" || recorded.kind === "journal_conflict") {
        this.clear(entry.id);
      }
      return recorded;
    } catch (error) {
      if (error === timeout) {
        logger.warn(`[BindingJournal] ${errorMessage(error)}`, error);
        return { kind: "removal_flag_timed_out" as const };
      }
      if (classifySqliteError(error) !== "retryable") {
        // Preserve non-retryable errors; the in-memory intent still prevents adoption.
        logger.warn(`[BindingJournal] Removal flag failed: ${errorMessage(error)}`, error);
        throw error;
      }
      if (immediate) {
        this.deps.pacing.noteBlocked(startedMs);
      }
      // Expected SQLite contention is retried on the shared pacing before any deletion.
      logger.debug(`[BindingJournal] Removal flag deferred: ${errorMessage(error)}`, error);
      return undefined;
    }
  }
}
