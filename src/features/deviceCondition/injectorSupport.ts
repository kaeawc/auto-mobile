import { ActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { DeviceConditionKey } from "./DeviceConditionTypes";

/** Shared adb plumbing for the deviceCondition injector families. */

export async function shell(
  adb: AdbExecutor,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await adb.execute(["shell", ...args], { signal });
  if (result.error) {
    throw new ActionableError(`adb shell ${args.join(" ")} failed: ${result.error}`);
  }
  return result.stdout.replace(/\r\n?/g, "\n").trim();
}

export function unsupported(reason: string): never {
  throw new ActionableError(`unsupported on this image: ${reason}`);
}

export function rejectValue(
  key: DeviceConditionKey,
  value: string,
  allowed: readonly string[],
): never {
  throw new ActionableError(
    `Invalid ${key} value '${value}'. Expected one of: ${allowed.join(", ")}.`,
  );
}

/** Run a top-level adb command (not `adb shell`), e.g. `root` or `remount`; returns trimmed stdout. */
export async function adbCommand(
  adb: AdbExecutor,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await adb.execute([...args], { signal });
  if (result.error) {
    throw new ActionableError(`adb ${args.join(" ")} failed: ${result.error}`);
  }
  return `${result.stdout}\n${result.stderr}`.replace(/\r\n?/g, "\n").trim();
}

/**
 * Runs tasks one at a time, in call order. A task that rejects does not block the next, so a
 * lease-expiry reset in flight cannot interleave with a new apply on the same injector.
 */
export function createSerializer(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
