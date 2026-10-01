import { ActionableError, type ExecResult } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";

export function touchscreenInputCommand(action: string, displayId?: number): string {
  const display = displayId === undefined ? "" : ` -d ${displayId}`;
  return `shell input touchscreen${display} ${action}`;
}

export function assertTouchscreenInputSucceeded(command: string, result: ExecResult): void {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (/(?:^|\r?\n)(?:Unknown command:|Error:|Usage: input\b)/.test(output)) {
    throw new ActionableError(`Android command failed: ${command}: ${output.trim()}`);
  }
}

export async function executeTouchscreenInput(
  adb: AdbExecutor,
  action: string,
  displayId?: number,
  signal?: AbortSignal,
): Promise<void> {
  const command = touchscreenInputCommand(action, displayId);
  const result = await adb.executeCommand(command, undefined, undefined, undefined, signal);
  assertTouchscreenInputSucceeded(command, result);
}
