import { outputReportsMissingPackage } from "./shellOutputHeuristics";

export type DumpsysPackagePresence =
  | { presence: "installed"; hidden: boolean; suspended: boolean }
  | { presence: "absent" }
  | { presence: "unknown"; reason: string };

/**
 * Presence of a package for one Android user from `dumpsys package <pkg>`.
 *
 * Absent is claimed only on positive evidence: PackageManager reporting no such package, or the
 * package's own per-user state line saying `installed=false` (retained data after
 * `pm uninstall -k`). Any other shape, such as an empty dump or a package with no state line for
 * the user, is `unknown`.
 */
export function parseDumpsysPackagePresence(
  output: string,
  packageName: string,
  userId: number,
): DumpsysPackagePresence {
  if (outputReportsMissingPackage(output) && !output.includes(`Package [${packageName}]`)) {
    return { presence: "absent" };
  }
  if (!output.includes(`Package [${packageName}]`)) {
    return { presence: "unknown", reason: "dumpsys package output has no Package section" };
  }
  const prefix = `User ${userId}:`;
  const stateLines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix) && /\binstalled=(?:true|false)\b/.test(line));
  if (stateLines.length !== 1) {
    return {
      presence: "unknown",
      reason: `dumpsys package has ${stateLines.length} state lines for user ${userId}`,
    };
  }
  const line = stateLines[0]!;
  if (/\binstalled=false\b/.test(line)) {
    return { presence: "absent" };
  }
  return {
    presence: "installed",
    hidden: /\bhidden=true\b/.test(line),
    suspended: /\bsuspended=true\b/.test(line),
  };
}
