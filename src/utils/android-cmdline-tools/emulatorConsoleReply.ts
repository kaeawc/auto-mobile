import { outputLooksLikeShellFailure } from "./shellOutputHeuristics";

/**
 * The emulator console answers `OK` on success and `KO: <reason>` on failure —
 * a convention the generic adb-shell heuristic (`exception`/`error:`) does not
 * cover, so check for the `KO` sentinel as well.
 */
export function emulatorConsoleReportsFailure(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`.trim();
  if (!combined) {
    return false;
  }
  if (/(^|\n)\s*KO\b/.test(combined)) {
    return true;
  }
  return outputLooksLikeShellFailure(stdout, stderr);
}

/**
 * The console's reason for a refusal: its first non-empty reply line, verbatim
 * (`KO: <reason>`). Call only after `emulatorConsoleReportsFailure` returned true.
 */
export function emulatorConsoleFailureReason(stdout: string, stderr: string): string {
  const line = `${stdout}\n${stderr}`.split(/\r?\n/).find((candidate) => candidate.trim());
  return line?.trim() ?? "the console gave no reason";
}
