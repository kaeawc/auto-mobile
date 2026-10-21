import type { AdbExecuteOptions } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

/**
 * The `executeCommand` argument tuple of the fakes: the command, then an options
 * object. Spies that receive `...args` use {@link executeCommandOptionsOf} instead
 * of reading slots by index.
 */
export type ExecuteCommandArgs = readonly [command: string, options?: AdbExecuteOptions];

export function executeCommandOptionsOf(args: ExecuteCommandArgs): AdbExecuteOptions {
  return args[1] ?? {};
}

/** The `executeCommand` parameters after the command, for overrides that forward to `super`. */
export type ExecuteCommandRest = ExecuteCommandArgs extends readonly [string, ...infer Rest]
  ? Rest
  : never;
