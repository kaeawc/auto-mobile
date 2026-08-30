const PROCESS_RECORD_PATTERN = /(?:^|\s)(\d+):([A-Za-z0-9_.:]+)\/(u(\d+)a\d+|\d+)(?=[\s}]|$)/gm;

/**
 * Finds a process PID for an Android package in the selected user, preferring
 * the package's main process over a `package:suffix` secondary process.
 */
export function findAndroidPackageProcessId(
  processesOutput: string,
  packageName: string,
  userId: number,
): number | null {
  PROCESS_RECORD_PATTERN.lastIndex = 0;
  let secondaryPid: number | null = null;

  for (const match of processesOutput.matchAll(PROCESS_RECORD_PATTERN)) {
    const processName = match[2];
    if (processName !== packageName && !processName.startsWith(`${packageName}:`)) {
      continue;
    }

    const uid = match[3];
    const processUserId = uid.startsWith("u")
      ? Number(match[4])
      : Math.floor(Number(uid) / 100_000);
    if (processUserId !== userId) {
      continue;
    }

    const pid = Number(match[1]);
    if (processName === packageName) {
      return pid;
    }
    secondaryPid ??= pid;
  }

  return secondaryPid;
}

/**
 * Determines whether an Android package has a process for the selected user.
 * Package-owned secondary processes (`com.example:worker`) count as running.
 *
 * App UIDs identify the user as `u<userId>a<appId>`, while system and
 * privileged processes use a numeric UID such as `1000`. Numeric system UIDs
 * belong to user 0; multi-user numeric UIDs encode the user in the leading
 * digits.
 *
 * When the hierarchy was captured by an older CtrlProxy that did not report a
 * user id, an omitted `userId` intentionally accepts a matching process for
 * any user. Newer callers should supply the captured user id.
 */
export function isAndroidPackageRunning(
  processesOutput: string,
  packageName: string,
  userId?: number,
): boolean {
  PROCESS_RECORD_PATTERN.lastIndex = 0;

  for (const match of processesOutput.matchAll(PROCESS_RECORD_PATTERN)) {
    if (match[2] !== packageName && !match[2].startsWith(`${packageName}:`)) {
      continue;
    }

    const uid = match[3];
    const processUserId = uid.startsWith("u")
      ? Number(match[4])
      : Math.floor(Number(uid) / 100_000);
    if (userId === undefined || processUserId === userId) {
      return true;
    }
  }

  return false;
}
