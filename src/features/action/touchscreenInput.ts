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

/** The `input` command ran and refused the request, so nothing was injected and a retry is safe. */
export class InputCommandRejectedError extends ActionableError {}

export function assertTouchscreenInputSucceeded(command: string, result: ExecResult): void {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (/(?:^|\r?\n)(?:Unknown command:|Error:|Usage: input\b)/.test(output)) {
    throw new InputCommandRejectedError(`Android command failed: ${command}: ${output.trim()}`);
  }
}

/** Dispatch context for one `shell input ...` command. */
export interface ShellInputOptions {
  signal?: AbortSignal;
  assertCurrent?: () => void;
  timeoutMs?: number;
  onDispatch?: () => void;
}

export async function executeTouchscreenInput(
  adb: AdbExecutor,
  action: string,
  displayId?: number,
  options: ShellInputOptions = {},
): Promise<void> {
  const { signal, assertCurrent, timeoutMs, onDispatch } = options;
  await executeShellInput(adb, touchscreenInputCommand(action, displayId), {
    signal,
    assertCurrent,
    timeoutMs,
    onDispatch,
  });
}

/**
 * Run one `shell input ...` command and fail on an `Error:`/`Usage:` output. With `assertCurrent`
 * the display fence is checked at the moment the command is dispatched, not when it is queued.
 */
export async function executeShellInput(
  adb: AdbExecutor,
  command: string,
  options: ShellInputOptions = {},
): Promise<void> {
  const { signal, assertCurrent, timeoutMs, onDispatch } = options;
  if (!assertCurrent) {
    // No dispatch hook on this path: report the send as it begins.
    onDispatch?.();
  }
  // Preserve executeCommand's single remote shell payload; execute exposes its dispatch hook.
  const result = assertCurrent
    ? await adb.execute(["shell", command.slice("shell ".length)], {
        signal,
        timeoutMs,
        beforeDispatch: async () => {
          assertCurrent();
          onDispatch?.();
        },
      })
    : await adb.executeCommand(command, { timeoutMs, signal });
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
