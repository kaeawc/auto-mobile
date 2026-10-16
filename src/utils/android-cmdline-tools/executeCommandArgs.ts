import type { AdbExecuteOptions } from "./interfaces/AdbExecutor";

/**
 * Normalizes the two accepted `executeCommand` call shapes into one options
 * object: the options form `executeCommand(command, { timeoutMs, ... })` and the
 * deprecated positional form `executeCommand(command, timeoutMs, maxBuffer, ...)`.
 * `onStdout` is only reachable positionally from fakes that predate the options
 * form; it is carried through unchanged.
 */
export function resolveExecuteCommandOptions(
  timeoutMsOrOptions?: number | AdbExecuteOptions,
  maxBuffer?: number,
  noRetry?: boolean,
  signal?: AbortSignal,
  waitForProcessSettlementAfterAbort?: boolean,
  onStdout?: (chunk: string) => void,
): AdbExecuteOptions {
  if (typeof timeoutMsOrOptions === "object" && timeoutMsOrOptions !== null) {
    return timeoutMsOrOptions;
  }
  return {
    timeoutMs: timeoutMsOrOptions,
    maxBuffer,
    noRetry,
    signal,
    waitForProcessSettlementAfterAbort,
    onStdout,
  };
}
