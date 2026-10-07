import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";

/** Only the package's pkgFlags list establishes debuggability, not permission flags. */
export function parseDebuggableBuild(output: string): boolean | undefined {
  const lines = output.split("\n").map((line) => line.trim());
  // The probe has no alternate user scope; retained data is not an installed user-0 app.
  const userState = lines.find((line) => line.startsWith("User 0:"));
  if (userState?.slice("User 0:".length).trim().split(/\s+/).includes("installed=false")) {
    return undefined;
  }
  const flagsLine = lines.find((line) => line.startsWith("pkgFlags=["));
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
    const result = await adb.executeCommand(
      `shell dumpsys package ${shellQuote(appId)}`,
      5000,
      DUMPSYS_MAX_BUFFER,
    );
    return parseDebuggableBuild(result.stdout);
  } catch (error) {
    logger.warn("[DebuggableBuildProbe] Android package probe failed", error);
    return undefined;
  }
}
