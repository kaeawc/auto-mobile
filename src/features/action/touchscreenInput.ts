import { ActionableError, type ExecResult } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";

/** Format the millisecond argument accepted by Android input's integer parser. */
export function inputDurationArgument(duration: number): number {
  return duration > 0 ? Math.max(1, Math.round(duration)) : Math.round(duration);
}

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
  assertCurrent?: () => void,
  options?: { timeoutMs?: number },
): Promise<void> {
  const command = touchscreenInputCommand(action, displayId);
  // Preserve executeCommand's single remote shell payload; execute exposes its dispatch hook.
  const result = assertCurrent
    ? await adb.execute(["shell", command.slice("shell ".length)], {
        signal,
        timeoutMs: options?.timeoutMs,
        beforeDispatch: async () => assertCurrent(),
      })
    : await adb.executeCommand(command, options?.timeoutMs, undefined, undefined, signal);
  assertTouchscreenInputSucceeded(command, result);
}

/** Core gestures always remain available; only non-default routing needs the new flag. */
export async function supportsCtrlProxyGestureDisplay(
  client: { supportsCommand?: (name: string) => Promise<boolean> },
  displayId?: number,
): Promise<boolean> {
  return (
    displayId === undefined ||
    displayId === 0 ||
    (await client.supportsCommand?.("gesture_display_id_v1")) === true
  );
}
