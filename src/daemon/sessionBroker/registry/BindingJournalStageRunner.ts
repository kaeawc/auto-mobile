import type { DeviceInfo } from "../../../models/index";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import type { Timer } from "../../../utils/SystemTimer";
import type {
  BindingDeletionResult,
  BindingDeviceClaims,
  BindingDeviceDeleter,
  BindingInventory,
  BindingInventorySnapshot,
} from "../provisioning/reconciler";
import type { BindingJournalEntry } from "./bindingRegistry";
import { BindingJournalDriveCancelled } from "./BindingJournalDriveCancelled";
import type { BindingJournalInFlight } from "./BindingJournalInFlight";
import { checkCancellation } from "./bindingJournalSupport";

export interface BindingJournalStageRunnerBudgets {
  discoveryMs: number;
  claimMs: number;
  deleteGraceMs: number;
}

export interface BindingJournalStageRunnerDependencies {
  inventory: BindingInventory;
  deleter: BindingDeviceDeleter;
  claims: BindingDeviceClaims;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  inFlight: BindingJournalInFlight;
  budgets: BindingJournalStageRunnerBudgets;
}

/**
 * Runs the journal's device-facing stages (discovery, claim lookup, delete + verify) under a
 * deadline, converting timeouts and failures into conservative results rather than absence.
 */
export class BindingJournalStageRunner {
  constructor(private readonly deps: BindingJournalStageRunnerDependencies) {}

  async boundedStage<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    options: { label: string; timeoutMs: number; signal?: AbortSignal; cancel?: AbortSignal },
    failure: (error: unknown) => T,
  ): Promise<T> {
    // Only journal-owned drives unwind; a public step records stage cancellation as failure.
    checkCancellation(options.cancel);
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const timeout = new Error(`${options.label} timed out after ${options.timeoutMs}ms`);
    try {
      const result = await raceWithDeadline(() => operation(signal), {
        timer: this.deps.timer,
        timeoutMs: Math.max(0, options.timeoutMs),
        signal: options.signal,
        label: options.label,
        timeoutError: () => timeout,
        onTimeout: () => controller.abort(timeout),
      });
      checkCancellation(options.cancel);
      return result;
    } catch (error) {
      if (options.cancel?.aborted) {
        controller.abort(options.cancel.reason);
        throw new BindingJournalDriveCancelled(options.cancel.reason);
      }
      // Unreadable discovery and unverified deletion are conservative failures, never absence.
      logger.warn(`[BindingJournal] ${options.label} failed: ${errorMessage(error)}`, error);
      return failure(
        options.signal?.aborted
          ? new Error(`${options.label} cancelled: ${errorMessage(error)}`)
          : error,
      );
    }
  }

  listInventory(
    entry: BindingJournalEntry,
    platform: BindingJournalEntry["platform"] = entry.platform,
    signal?: AbortSignal,
  ): Promise<BindingInventorySnapshot | null> {
    return this.boundedStage<BindingInventorySnapshot | null>(
      (stageSignal) => this.deps.inventory.list(platform, { signal: stageSignal }),
      {
        label: `discovery for entry ${entry.id}`,
        timeoutMs: this.deps.budgets.discoveryMs,
        signal,
        cancel: signal,
      },
      () => null,
    );
  }

  describeClaim(entry: BindingJournalEntry, device: DeviceInfo, signal?: AbortSignal) {
    return this.boundedStage<Awaited<ReturnType<BindingDeviceClaims["describe"]>>>(
      () => this.deps.claims.describe(device),
      {
        label: `claim for entry ${entry.id}`,
        timeoutMs: this.deps.budgets.claimMs,
        signal,
        cancel: signal,
      },
      (error) => ({ kind: "unknown", reason: errorMessage(error) }),
    );
  }

  async deleteDevice(
    target: Parameters<BindingDeviceDeleter["deleteAndVerifyAbsence"]>[0],
    cancel?: AbortSignal,
    hardDeadlineMs?: number,
  ): Promise<BindingDeletionResult & { nativeDeleteFailed?: boolean }> {
    const { inFlight } = this.deps;
    if (inFlight.removalBlocked(target.platform, target.stableId)) {
      return {
        kind: "failed",
        message: `Removal of device '${target.stableId}' is still in flight.`,
      };
    }
    let operation: Promise<BindingDeletionResult> | undefined;
    try {
      const result = await this.boundedStage<BindingDeletionResult>(
        (signal) => {
          operation = inFlight.trackRemoval(target.platform, target.stableId, () =>
            this.deps.deleter.deleteAndVerifyAbsence({ ...target, signal }),
          );
          return operation;
        },
        {
          label: `deleting '${target.stableId}'`,
          timeoutMs: Math.max(
            0,
            Math.min(
              target.deadlineMs + this.deps.budgets.deleteGraceMs,
              hardDeadlineMs ?? Infinity,
            ) - this.deps.timer.now(),
          ),
          signal: target.signal,
          cancel,
        },
        (error) => ({ kind: "failed", message: errorMessage(error) }),
      );
      return {
        ...result,
        nativeDeleteFailed:
          operation !== undefined && result.kind === "failed" && !result.notAttempted,
      };
    } finally {
      if (operation) {
        inFlight.markRemovalOverdue(operation, this.deps.timer.now());
      }
    }
  }
}
