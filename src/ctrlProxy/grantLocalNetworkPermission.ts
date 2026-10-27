import { errorMessage } from "../utils/describeUnknownError";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { userFlag } from "./setupUser";
import { logger } from "../utils/logger";

const LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK";
const LOCAL_NETWORK_PERMISSION_MIN_API_LEVEL = 37;

/**
 * Grants the runtime ACCESS_LOCAL_NETWORK permission (API 37+) so prototype `via: "device"`
 * requests to private hosts are not refused (#13018). Best effort: a failed grant never fails
 * install or upgrade, and images that do not know the permission are skipped.
 */
export async function grantLocalNetworkPermission(
  adb: AdbExecutor,
  packageName: string,
  apiLevel: number | null,
  userId?: number,
): Promise<void> {
  if (apiLevel === null || apiLevel < LOCAL_NETWORK_PERMISSION_MIN_API_LEVEL) {
    return;
  }
  try {
    const result = await adb.executeCommand(
      `shell pm grant${userFlag(userId)} ${packageName} ${LOCAL_NETWORK_PERMISSION}`,
      { noRetry: true },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (/unknown permission|exception/i.test(output)) {
      // Images that predate the permission reject the grant; CtrlProxy works without it.
      logger.debug(`[CTRL_PROXY] ${LOCAL_NETWORK_PERMISSION} not grantable: ${output.trim()}`);
    }
  } catch (error) {
    logger.warn(
      `[CTRL_PROXY] Failed to grant ${LOCAL_NETWORK_PERMISSION}: ${errorMessage(error)}`,
      error,
    );
  }
}
