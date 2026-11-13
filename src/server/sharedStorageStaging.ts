import { ActionableError, type ExecResult } from "../models";
import {
  AdbSharedStorageDiagnostics,
  type SharedStorageDiagnostics,
  SHARED_STORAGE_RECYCLE_DEVICE,
  sharedStorageAdbErrorMessage,
} from "./sharedStorageDiagnostics";
import { SHARED_STORAGE_DIAGNOSTICS_TOTAL_TIMEOUT_MS } from "../features/storage/fileTransferTimeout";
import { ADB_ABORT_SETTLEMENT_MAX_MS } from "../utils/android-cmdline-tools/AdbSignalExecutor";
import type {
  AdbExecutor,
  AdbExecuteOptions,
} from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { combineWithAmbientAbort, runOutsideRequestContext } from "../utils/AbortContext";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { shellQuote } from "../utils/shellQuote";
import type { Timer } from "../utils/SystemTimer";

/**
 * Wait for a timed-out stage's aborted adb command to settle before cleanup or rollback; covers the
 * executor's SIGTERM and SIGKILL grace with slack for the executor's own timers to fire first.
 */
export const SHARED_STORAGE_ABORT_SETTLEMENT_TIMEOUT_MS = ADB_ABORT_SETTLEMENT_MAX_MS + 500;

export interface SharedStorageStageCommand {
  destination: string;
  stage: "mkdir" | "push" | "commit" | "media-scan" | "media-query" | "reset" | "backup";
  command: string | string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

/** One bounded command with enough context to diagnose a stalled fixture without reproducing it. */
export class SharedStorageStages {
  constructor(
    private readonly timer: Timer,
    private readonly diagnostics: SharedStorageDiagnostics = new AdbSharedStorageDiagnostics(),
  ) {}

  run(adb: AdbExecutor, context: SharedStorageStageCommand): Promise<ExecResult>;
  run<T>(
    adb: AdbExecutor,
    context: SharedStorageStageCommand,
    operation: (options: AdbExecuteOptions) => Promise<T>,
  ): Promise<T>;
  async run<T>(
    adb: AdbExecutor,
    context: SharedStorageStageCommand,
    operation?: (options: AdbExecuteOptions) => Promise<T>,
  ): Promise<T | ExecResult> {
    const started = this.timer.now();
    const controller = new AbortController();
    const signal = combineWithAmbientAbort(context.signal);
    const options: AdbExecuteOptions = {
      timeoutMs: context.timeoutMs,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      noRetry: true,
      waitForProcessSettlementAfterAbort: true,
    };
    let pending: Promise<T | ExecResult> | undefined;
    try {
      return await raceWithDeadline<T | ExecResult>(
        () => {
          pending = operation
            ? operation(options)
            : typeof context.command === "string"
              ? adb.executeCommand(context.command, options)
              : adb.execute(context.command, options);
          return pending;
        },
        {
          timer: this.timer,
          timeoutMs: context.timeoutMs,
          // Let adb settle caller cancellation before cleanup/rollback, preserving write order.
          label: `Shared-storage ${context.stage}`,
          onTimeout: () => controller.abort(),
        },
      );
    } catch (error) {
      const failure = this.failure(adb, context, started, error);
      if (controller.signal.aborted && pending) {
        // The deadline lost the race while the aborted write may still be running; cleanup and
        // rollback start once this throws, so wait for adb to stop writing (diagnostics overlap).
        await this.awaitAbortSettlement(pending, context);
      }
      throw await failure;
    }
  }

  private async awaitAbortSettlement(
    pending: Promise<unknown>,
    context: SharedStorageStageCommand,
  ): Promise<void> {
    try {
      await raceWithDeadline(
        pending.then(
          () => undefined,
          () => undefined,
        ),
        {
          timer: this.timer,
          timeoutMs: SHARED_STORAGE_ABORT_SETTLEMENT_TIMEOUT_MS,
          label: `Shared-storage ${context.stage} abort settlement`,
        },
      );
    } catch (settlementError) {
      logger.warn(
        `[SharedStorage] Aborted ${context.stage} for ${context.destination} did not settle; continuing with cleanup`,
        settlementError,
      );
    }
  }

  async failure(
    adb: AdbExecutor,
    context: SharedStorageStageCommand,
    started: number,
    error: unknown,
  ): Promise<ActionableError> {
    const elapsed = this.timer.now() - started;
    let state: string;
    try {
      state = await runOutsideRequestContext(() =>
        raceWithDeadline(() => this.diagnostics.collect(adb, this.timer), {
          timer: this.timer,
          timeoutMs: SHARED_STORAGE_DIAGNOSTICS_TOTAL_TIMEOUT_MS,
          label: "Shared-storage diagnostics",
        }),
      );
    } catch (diagnosticError) {
      logger.warn("[SharedStorage] Device diagnostics unavailable", diagnosticError);
      state = `${SHARED_STORAGE_RECYCLE_DEVICE}\nDiagnostics unavailable: ${sharedStorageAdbErrorMessage(diagnosticError)}`;
    }
    const command =
      typeof context.command === "string"
        ? context.command
        : context.command.map(shellQuote).join(" ");
    return new ActionableError(
      `Android shared-storage staging failed for ${context.destination}; stage=${context.stage}; ` +
        `command: adb ${command}; timeout=${context.timeoutMs}ms; elapsed=${elapsed}ms: ` +
        `${sharedStorageAdbErrorMessage(error)}\nDevice state:\n${state}`,
      { cause: error },
    );
  }
}
