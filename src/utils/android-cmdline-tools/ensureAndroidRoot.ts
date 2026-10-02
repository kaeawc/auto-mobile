import type { AdbExecutor } from "./interfaces/AdbExecutor";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";

/** Root capability probe shared by the legacy locale and emulator clock paths. */
export async function ensureAndroidRoot(
  adb: Pick<AdbExecutor, "executeCommand">,
  signal?: AbortSignal,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    signal?.throwIfAborted();
    await adb.executeCommand("root", 30_000, undefined, true, signal);
    signal?.throwIfAborted();
    await adb.executeCommand("wait-for-device", 60_000, undefined, true, signal);
    signal?.throwIfAborted();
    const result = await adb.executeCommand("shell id", 30_000, undefined, true, signal);
    if (!result.stdout.includes("uid=0(root)")) {
      return {
        success: false,
        error: `adb root completed, but ADB shell is still not root; the target emulator is not root-capable. shell id: ${result.stdout.trim() || "unknown"}`,
      };
    }
    return { success: true };
  } catch (error) {
    logger.warn("Failed to establish root ADB shell", error);
    return {
      success: false,
      error: `Failed to run adb root or verify root shell; the target emulator is not root-capable or does not allow root ADB: ${errorMessage(error)}`,
    };
  }
}
