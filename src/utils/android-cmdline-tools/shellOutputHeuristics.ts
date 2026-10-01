/**
 * Heuristic: treat adb shell stdout/stderr as failure when it clearly looks like an Android/Java error.
 * (Exit code is not always reliable for `adb shell` compound commands.)
 */
export function outputLooksLikeShellFailure(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`.trim();
  if (!combined) {
    return false;
  }
  return /exception|error:/i.test(combined);
}

/** Match an exact package entry from `pm list packages` output. */
export function packageListingContains(stdout: string, packageName: string): boolean {
  return stdout.split("\n").some((line) => line.trim() === `package:${packageName}`);
}

/** Match the package-manager message emitted when `dumpsys package` cannot find a package. */
export function outputReportsMissingPackage(stdout: string): boolean {
  return /Unable to find package/i.test(stdout);
}
