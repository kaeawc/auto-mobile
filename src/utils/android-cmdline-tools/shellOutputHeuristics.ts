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
