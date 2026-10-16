import type { AdbExecuteOptions } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { resolveExecuteCommandOptions } from "../../src/utils/android-cmdline-tools/executeCommandArgs";

/**
 * The `executeCommand` argument tuple of the fakes: the command, then either an
 * options object or the deprecated positional slots. Spies that receive
 * `...args` use {@link executeCommandOptionsOf} instead of reading slots by index.
 */
export type ExecuteCommandArgs = readonly [
  command: string,
  timeoutMsOrOptions?: number | AdbExecuteOptions,
  maxBuffer?: number,
  noRetry?: boolean,
  signal?: AbortSignal,
  waitForProcessSettlementAfterAbort?: boolean,
  onStdout?: (chunk: string) => void,
];

export function executeCommandOptionsOf(args: ExecuteCommandArgs): AdbExecuteOptions {
  return resolveExecuteCommandOptions(args[1], args[2], args[3], args[4], args[5], args[6]);
}

/** The `executeCommand` parameters after the command, for overrides that forward to `super`. */
export type ExecuteCommandRest = ExecuteCommandArgs extends readonly [string, ...infer Rest]
  ? Rest
  : never;
