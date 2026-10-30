import { errorMessage } from "../utils/describeUnknownError";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { userFlag } from "./setupUser";
import { logger } from "../utils/logger";
import { CTRL_PROXY_PACKAGE } from "./constants";

const RECORD_AUDIO_PERMISSION = "android.permission.RECORD_AUDIO";

/** Best effort: microphone capture is optional and a failed grant must never fail installation. */
export async function grantRecordAudioPermission(adb: AdbExecutor, userId?: number): Promise<void> {
  try {
    const result = await adb.executeCommand(
      `shell pm grant${userFlag(userId)} ${CTRL_PROXY_PACKAGE} ${RECORD_AUDIO_PERMISSION}`,
      { noRetry: true },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (/unknown permission|exception/i.test(output)) {
      logger.debug(`[CTRL_PROXY] ${RECORD_AUDIO_PERMISSION} not grantable: ${output.trim()}`);
    }
  } catch (error) {
    logger.warn(
      `[CTRL_PROXY] Failed to grant ${RECORD_AUDIO_PERMISSION}: ${errorMessage(error)}`,
      error,
    );
  }
}
