import type { DisplayPanel } from "../../models/DisplayPanel";
import type { AdbCommandRunner } from "./interfaces/AdbExecutor";
import {
  logicalDisplayIdForPanel,
  panelKeyForUniqueId,
  parseAndroidDisplayInfos,
  parseDumpsysLogicalDisplays,
  type AndroidDisplayInfo,
} from "./AndroidDisplayParsers";
import { DUMPSYS_MAX_BUFFER } from "./dumpsysLimits";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";

/** Private secondary displays may be absent from the shell caller's get-displays list. */
export async function readAndroidLogicalDisplays(
  adb: AdbCommandRunner,
  panels: readonly DisplayPanel[],
  signal?: AbortSignal,
): Promise<AndroidDisplayInfo[]> {
  const output = await adb.executeCommand("shell cmd display get-displays", {
    timeoutMs: 2000,
    noRetry: true,
    signal,
  });
  signal?.throwIfAborted();
  const infos = parseAndroidDisplayInfos(output.stdout);
  const missingKeys = new Set(
    panels
      .filter(
        (panel) =>
          (panel.role === "virtual" || panel.role === "overlay" || panel.role === "cluster") &&
          logicalDisplayIdForPanel(infos, panel.key) === undefined,
      )
      .map((panel) => panel.key),
  );
  if (missingKeys.size === 0) {
    return infos;
  }
  try {
    const dump = await adb.executeCommand("shell dumpsys display", {
      timeoutMs: 2000,
      maxBuffer: DUMPSYS_MAX_BUFFER,
      noRetry: true,
      signal,
    });
    signal?.throwIfAborted();
    // Reserve display 0 even when the primary list is empty; supplementation is secondary-only.
    const reportedIds = new Set(["0", ...infos.map((info) => info.logicalId)]);
    for (const info of parseDumpsysLogicalDisplays(dump.stdout)) {
      if (
        !reportedIds.has(info.logicalId) &&
        info.uniqueId !== undefined &&
        missingKeys.has(panelKeyForUniqueId(info.uniqueId))
      ) {
        infos.push(info);
        reportedIds.add(info.logicalId);
      }
    }
    return infos;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    // Supplementation is optional; retain the connection evidence the primary read established.
    logger.warn(`Unable to read Android private logical displays: ${errorMessage(error)}`, error);
    return infos;
  }
}
