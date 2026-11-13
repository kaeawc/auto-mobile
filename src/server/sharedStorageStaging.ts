import { ActionableError, type ExecResult } from "../models";
import {
  AdbSharedStorageDiagnostics,
  type SharedStorageDiagnostics,
  SHARED_STORAGE_RECYCLE_DEVICE,
  sharedStorageAdbErrorMessage,
} from "./sharedStorageDiagnostics";
import { SHARED_STORAGE_DIAGNOSTICS_TOTAL_TIMEOUT_MS } from "../features/storage/fileTransferTimeout";
import type {
  AdbExecutor,
  AdbExecuteOptions,
} from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { combineWithAmbientAbort, runOutsideRequestContext } from "../utils/AbortContext";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { shellQuote } from "../utils/shellQuote";
import type { Timer } from "../utils/SystemTimer";

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
    try {
      return await raceWithDeadline<T | ExecResult>(
        () =>
          operation
            ? operation(options)
            : typeof context.command === "string"
              ? adb.executeCommand(context.command, options)
              : adb.execute(context.command, options),
        {
          timer: this.timer,
          timeoutMs: context.timeoutMs,
          // Let adb settle caller cancellation before cleanup/rollback, preserving write order.
          label: `Shared-storage ${context.stage}`,
          onTimeout: () => controller.abort(),
        },
      );
    } catch (error) {
      throw await this.failure(adb, context, started, error);
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
