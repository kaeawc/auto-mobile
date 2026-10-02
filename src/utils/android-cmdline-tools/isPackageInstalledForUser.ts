import type { AdbExecutor } from "./interfaces/AdbExecutor";
import { packageListingContains } from "./shellOutputHeuristics";

/** Check one user's installed packages without including retained/uninstalled packages. */
export async function isPackageInstalledForUser(
  adb: AdbExecutor,
  packageName: string,
  userId: number,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await adb.executeCommand(
    `shell pm list packages --user ${userId}`,
    timeoutMs,
    undefined,
    true,
    signal,
  );
  return packageListingContains(result.stdout, packageName);
}
