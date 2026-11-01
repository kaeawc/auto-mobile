import { errorMessage } from "../utils/describeUnknownError";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { adbFailureOutput } from "../utils/android-cmdline-tools/adbFailureOutput";
import { outputLooksLikeShellFailure } from "../utils/android-cmdline-tools/shellOutputHeuristics";
import { logger } from "../utils/logger";
import { CTRL_PROXY_PACKAGE } from "./constants";
import { userFlag } from "./setupUser";
import { AdbCommandTimeoutError } from "../utils/android-cmdline-tools/AdbCommandTimeoutError";
import { ActionableError } from "../models/ActionableError";

export const RECORD_AUDIO_PERMISSION = "android.permission.RECORD_AUDIO";

export type RecordAudioPermissionGrant =
  | { granted: true }
  | { granted: false; reason: string; transportError?: unknown };

function isTimeout(error: unknown): boolean {
  return (
    error instanceof AdbCommandTimeoutError ||
    (!(error instanceof ActionableError) &&
      /\b(?:timeout|timed out|ETIMEDOUT)\b/i.test(errorMessage(error)))
  );
}

function refusalFromOutput(stdout: string, stderr: string): string | undefined {
  const output = `${stdout}\n${stderr}`;
  if (/unknown permission/i.test(output) || outputLooksLikeShellFailure(stdout, stderr)) {
    return output.trim();
  }
  return undefined;
}

/** Best effort: microphone capture is optional and a failed grant must never fail installation. */
export async function grantRecordAudioPermission(
  adb: Pick<AdbExecutor, "execute">,
  userId?: number,
  timeoutMs = 10_000,
  timeoutForAttempt?: () => number,
): Promise<RecordAudioPermissionGrant> {
  for (let attempt = 0; ; attempt++) {
    let result;
    try {
      result = await adb.execute(
        `shell pm grant${userFlag(userId)} ${CTRL_PROXY_PACKAGE} ${RECORD_AUDIO_PERMISSION}`.split(
          " ",
        ),
        { noRetry: true, timeoutMs: Math.min(timeoutMs, timeoutForAttempt?.() ?? timeoutMs) },
      );
      if (result.error) {
        throw new Error(result.error);
      }
    } catch (error) {
      const { stdout, stderr } = adbFailureOutput(error);
      const reason = refusalFromOutput(stdout, stderr);
      if (reason !== undefined) {
        logger.warn(`[CTRL_PROXY] ${RECORD_AUDIO_PERMISSION} not grantable: ${reason}`);
        return { granted: false, reason };
      }
      if (attempt === 0 && isTimeout(error)) {
        // Retrying is safe: pm grant is idempotent and no device refusal was observed.
        logger.debug(`[CTRL_PROXY] Retrying ${RECORD_AUDIO_PERMISSION} after a grant timeout`);
        continue;
      }
      logger.warn(
        `[CTRL_PROXY] Failed to grant ${RECORD_AUDIO_PERMISSION}: ${errorMessage(error)}`,
        error,
      );
      return { granted: false, reason: errorMessage(error), transportError: error };
    }
    const output = `${result.stdout}${result.stderr}`;
    if (
      /unknown permission/i.test(output) ||
      outputLooksLikeShellFailure(result.stdout, result.stderr)
    ) {
      const reason = output.trim();
      logger.warn(`[CTRL_PROXY] ${RECORD_AUDIO_PERMISSION} not grantable: ${reason}`);
      return { granted: false, reason };
    }
    return { granted: true };
  }
}
