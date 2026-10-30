import { errorMessage } from "../utils/describeUnknownError";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { outputLooksLikeShellFailure } from "../utils/android-cmdline-tools/shellOutputHeuristics";
import { logger } from "../utils/logger";
import { CTRL_PROXY_PACKAGE } from "./constants";

export const RECORD_AUDIO_PERMISSION = "android.permission.RECORD_AUDIO";

export type RecordAudioPermissionGrant = { granted: true } | { granted: false; reason: string };

/** Best effort: microphone capture is optional and a failed grant must never fail installation. */
export async function grantRecordAudioPermission(
  adb: Pick<AdbExecutor, "execute">,
  userId?: number,
  timeoutMs = 2_000,
): Promise<RecordAudioPermissionGrant> {
  try {
    const result = await adb.execute(
      [
        "shell",
        "pm",
        "grant",
        ...(userId === undefined ? [] : ["--user", String(userId)]),
        CTRL_PROXY_PACKAGE,
        RECORD_AUDIO_PERMISSION,
      ],
      { noRetry: true, timeoutMs },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (
      result.error ||
      /unknown permission/i.test(output) ||
      outputLooksLikeShellFailure(result.stdout, result.stderr)
    ) {
      const reason = result.error || output.trim();
      logger.warn(`[CTRL_PROXY] ${RECORD_AUDIO_PERMISSION} not grantable: ${reason}`);
      return { granted: false, reason };
    }
    return { granted: true };
  } catch (error) {
    logger.warn(
      `[CTRL_PROXY] Failed to grant ${RECORD_AUDIO_PERMISSION}: ${errorMessage(error)}`,
      error,
    );
    return { granted: false, reason: errorMessage(error) };
  }
}
