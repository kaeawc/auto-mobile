const PROCESS_RECORD_PATTERN = /(?:^|\s)\d+:([A-Za-z0-9_.:]+)\/(u(\d+)a\d+|\d+)(?=[\s}]|$)/gm;

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
    if (match[1] !== packageName && !match[1].startsWith(`${packageName}:`)) {
      continue;
    }

    const uid = match[2];
    const processUserId = uid.startsWith("u")
      ? Number(match[3])
      : Math.floor(Number(uid) / 100_000);
    if (userId === undefined || processUserId === userId) {
      return true;
    }
  }

  return false;
}
