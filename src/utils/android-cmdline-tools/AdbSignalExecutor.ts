import { ExecResult } from "../../models";
import {
  type HostChildProcess as ChildProcess,
  type HostProcessExecutor,
} from "../HostCommandExecutor";
import { logger } from "../logger";
import { Timer } from "../SystemTimer";
import { activeProcesses, removeFinishedAdbChild, trackActiveAdbChild } from "./adbActiveProcesses";
import { AdbCommandTimeoutError } from "./AdbCommandTimeoutError";
import { getAdbAbortError } from "./adbTransportRecovery";
import { type AdbExecuteOptions } from "./interfaces/AdbExecutor";
type ExecFileAsync = (file: string, args: string[], maxBuffer?: number) => Promise<ExecResult>;
const PROCESS_SETTLEMENT_GRACE_MS = 1_000;
/** Per-command buffer, deadline, cancellation and stdout observation for one ADB process. */
export type AdbSignalExecOptions = Pick<
  AdbExecuteOptions,
  "maxBuffer" | "timeoutMs" | "signal" | "waitForProcessSettlementAfterAbort" | "onStdout"
>;
export class AdbSignalExecutor {
  constructor(
    private readonly context: {
      isTestMode: boolean;
      execAsync: ExecFileAsync;
      hostProcessExecutor: HostProcessExecutor;
      timer: Timer;
    },
  ) {}

  async execWithSignal(
    file: string,
    args: string[],
    options: AdbSignalExecOptions = {},
  ): Promise<ExecResult> {
    const { maxBuffer, timeoutMs, signal, waitForProcessSettlementAfterAbort, onStdout } = options;
    if (signal?.aborted) {
      throw getAdbAbortError(signal);
    }

    if (this.context.isTestMode) {
      return this.context.execAsync(file, args, maxBuffer);
    }

    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      let pendingTerminationError: Error | undefined;
      let terminationTimeoutId: NodeJS.Timeout | undefined;
      let killSettlementTimeoutId: NodeJS.Timeout | undefined;
      const { child, result } = this.context.hostProcessExecutor.executeCommandWithChild(
        file,
        args,
        maxBuffer ? { maxBuffer } : undefined,
      );
      const stopObservingStdout = this.observeStdout(child, onStdout);
      result
        .then((execResult) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          if (pendingTerminationError) {
            reject(pendingTerminationError);
            return;
          }
          resolve(execResult);
        })
        .catch((error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(pendingTerminationError ?? error);
        });

      trackActiveAdbChild(child);

      const onAbort = () => {
        if (settled) {
          return;
        }
        const abortError = getAdbAbortError(signal);
        if (waitForProcessSettlementAfterAbort) {
          pendingTerminationError ??= abortError;
          if (timeoutId) {
            this.context.timer.clearTimeout(timeoutId);
          }
          signal?.removeEventListener("abort", onAbort);
          child.kill("SIGTERM");
          terminationTimeoutId = this.context.timer.setTimeout(() => {
            if (settled) {
              return;
            }
            child.kill("SIGKILL");
            waitForProcessExitAfterSigkill();
          }, PROCESS_SETTLEMENT_GRACE_MS);
          return;
        }
        settled = true;
        cleanup();
        child.kill("SIGTERM");
        reject(abortError);
      };

      const onExit = () => {
        activeProcesses.delete(child);
      };

      const settleAfterSigkill = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(pendingTerminationError);
      };

      const waitForProcessExitAfterSigkill = () => {
        child.once("exit", settleAfterSigkill);
        child.once("close", settleAfterSigkill);
        killSettlementTimeoutId = this.context.timer.setTimeout(() => {
          if (settled) {
            return;
          }
          logger.warn(
            `[ADB] Child did not exit after SIGKILL within ${PROCESS_SETTLEMENT_GRACE_MS}ms; settling command termination`,
          );
          settleAfterSigkill();
        }, PROCESS_SETTLEMENT_GRACE_MS);
      };

      const cleanup = () => {
        stopObservingStdout();
        removeFinishedAdbChild(child);
        child.off("exit", onExit);
        child.off("exit", settleAfterSigkill);
        child.off("close", settleAfterSigkill);
        signal?.removeEventListener("abort", onAbort);
        if (timeoutId) {
          this.context.timer.clearTimeout(timeoutId);
        }
        if (terminationTimeoutId) {
          this.context.timer.clearTimeout(terminationTimeoutId);
        }
        if (killSettlementTimeoutId) {
          this.context.timer.clearTimeout(killSettlementTimeoutId);
        }
      };

      let timeoutId: NodeJS.Timeout | undefined;
      if (timeoutMs) {
        timeoutId = this.context.timer.setTimeout(() => {
          if (settled) {
            return;
          }
          const timeoutError = new AdbCommandTimeoutError(
            `Command timed out after ${timeoutMs}ms: ${file} ${args.join(" ")}`,
          );
          if (waitForProcessSettlementAfterAbort) {
            pendingTerminationError ??= timeoutError;
            signal?.removeEventListener("abort", onAbort);
            child.kill("SIGTERM");
            terminationTimeoutId = this.context.timer.setTimeout(() => {
              if (settled) {
                return;
              }
              child.kill("SIGKILL");
              waitForProcessExitAfterSigkill();
            }, PROCESS_SETTLEMENT_GRACE_MS);
            return;
          }
          settled = true;
          cleanup();
          child.kill("SIGTERM");
          reject(timeoutError);
        }, timeoutMs);
      }

      child.on("exit", onExit);

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  private observeStdout(child: ChildProcess, onStdout?: (chunk: string) => void): () => void {
    if (!onStdout || !child.stdout) {
      return () => {};
    }
    const listener = (chunk: Buffer | string) => onStdout(chunk.toString());
    child.stdout.on("data", listener);
    return () => {
      child.stdout?.off("data", listener);
    };
  }
}
