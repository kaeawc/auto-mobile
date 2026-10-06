import { DUMPSYS_MAX_BUFFER } from "./dumpsysLimits";
import type { AdbExecutor } from "./interfaces/AdbExecutor";
import { parseWindowManagerRotation } from "./parseWindowManagerRotation";
import { throwIfAborted } from "../toolUtils";
import { logger } from "../logger";

export const WINDOW_MANAGER_ROTATION_COMMAND = "shell dumpsys window displays";
export const WINDOW_MANAGER_ROTATION_FALLBACK_COMMAND =
  'shell dumpsys window | grep -i "mRotation="';
export const WINDOW_MANAGER_ROTATION_TIMEOUT_MS = 5_000;
// Preserve the exported rotation limit as an alias of the shared dumpsys cap.
export const WINDOW_MANAGER_ROTATION_MAX_BUFFER = DUMPSYS_MAX_BUFFER;

export async function readWindowManagerRotation(
  adb: Pick<AdbExecutor, "executeCommand">,
  options: { displayId?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<number | null> {
  const timeoutMs = options.timeoutMs ?? WINDOW_MANAGER_ROTATION_TIMEOUT_MS;
  const defaultDisplay = (options.displayId ?? 0) === 0;
  let fallbackReason = "display 0 rotation is missing";
  let fallbackError: unknown;
  try {
    const { stdout } = await adb.executeCommand(
      WINDOW_MANAGER_ROTATION_COMMAND,
      timeoutMs,
      WINDOW_MANAGER_ROTATION_MAX_BUFFER,
      undefined,
      options.signal,
    );
    const rotation = parseWindowManagerRotation(stdout, { displayId: options.displayId });
    if (rotation !== null || !defaultDisplay) {
      return rotation;
    }
  } catch (error) {
    if (
      options.signal?.aborted ||
      (error instanceof Error && error.name === "AbortError") ||
      !defaultDisplay
    ) {
      throw error;
    }
    fallbackReason = "the displays subcommand failed";
    fallbackError = error;
  }
  throwIfAborted(options.signal);
  // Missing display 0 rotation or a failing displays subcommand is expected on older Android releases.
  logger.debug(
    `[readWindowManagerRotation] Falling back to legacy WindowManager rotation: ${fallbackReason}`,
    fallbackError,
  );
  const { stdout } = await adb.executeCommand(
    WINDOW_MANAGER_ROTATION_FALLBACK_COMMAND,
    timeoutMs,
    WINDOW_MANAGER_ROTATION_MAX_BUFFER,
    undefined,
    options.signal,
  );
  return parseWindowManagerRotation(stdout);
}
