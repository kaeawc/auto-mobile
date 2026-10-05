import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";

/** Only the package's pkgFlags list establishes debuggability, not permission flags. */
export function parseDebuggableBuild(output: string): boolean | undefined {
  const flagsLine = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("pkgFlags=["));
  if (!flagsLine || !flagsLine.endsWith("]")) {
    return undefined;
  }
  return flagsLine.slice("pkgFlags=[".length, -1).trim().split(/\s+/).includes("DEBUGGABLE");
}

/** Best-effort diagnostic: a failed package query cannot establish debuggability. */
export async function probeDebuggableBuild(
  adb: AdbExecutor,
  appId: string,
): Promise<boolean | undefined> {
  try {
    const result = await adb.executeCommand(`shell dumpsys package ${shellQuote(appId)}`, 5000);
    return parseDebuggableBuild(result.stdout);
  } catch (error) {
    logger.warn("[DebuggableBuildProbe] Android package probe failed", error);
    return undefined;
  }
}
