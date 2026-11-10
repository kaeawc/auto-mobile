import type { DisplayPanel } from "../../models/DisplayPanel";
import { ActionableError } from "../../models/ActionableError";
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

/** `cmd display` on API 30 and older has no `get-displays` subcommand (#17742). */
const GET_DISPLAYS_UNSUPPORTED = /\bUnknown command:?\s*get-displays\b/i;

/**
 * No display inventory source works on this device: `get-displays` is unsupported and the
 * `dumpsys display` fallback could not be read or parsed. Retrying cannot help.
 */
export class AndroidDisplayListUnavailableError extends ActionableError {}

function isGetDisplaysUnsupported(evidence: unknown): boolean {
  return GET_DISPLAYS_UNSUPPORTED.test(
    typeof evidence === "string" ? evidence : errorMessage(evidence),
  );
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

async function readDumpsysDisplay(adb: AdbCommandRunner, signal?: AbortSignal): Promise<string> {
  const dump = await adb.executeCommand("shell dumpsys display", {
    timeoutMs: 2000,
    maxBuffer: DUMPSYS_MAX_BUFFER,
    noRetry: true,
    signal,
  });
  signal?.throwIfAborted();
  return dump.stdout;
}

function unavailableMessage(detail: string): string {
  return (
    `Android display list is unavailable on this device: "cmd display get-displays" is not ` +
    `supported (Android 11 / API 30 and older) and ${detail}. Display-scoped calls cannot ` +
    `resolve a panel here; omit display to use the default display.`
  );
}

/** The whole logical display list from `dumpsys display`, for devices without get-displays. */
async function readDumpsysLogicalDisplays(
  adb: AdbCommandRunner,
  signal?: AbortSignal,
): Promise<AndroidDisplayInfo[]> {
  let output: string;
  try {
    output = await readDumpsysDisplay(adb, signal);
  } catch (error) {
    if (isAbort(error, signal)) {
      throw error;
    }
    throw new AndroidDisplayListUnavailableError(
      unavailableMessage(`"dumpsys display" could not be read: ${errorMessage(error)}`),
    );
  }
  const infos = parseDumpsysLogicalDisplays(output);
  if (!infos.some((info) => info.logicalId === "0")) {
    // Every booted device has logical display 0; without it the dump format was not recognized.
    throw new AndroidDisplayListUnavailableError(
      unavailableMessage(`"dumpsys display" reported no recognizable logical display 0`),
    );
  }
  return infos;
}

/**
 * The shell caller's `get-displays` list, or null when this OS has no such subcommand. Some
 * builds exit non-zero (API 30 exits 255) and others print the refusal on stdout.
 */
async function readGetDisplays(
  adb: AdbCommandRunner,
  signal?: AbortSignal,
): Promise<AndroidDisplayInfo[] | null> {
  try {
    const output = await adb.executeCommand("shell cmd display get-displays", {
      timeoutMs: 2000,
      noRetry: true,
      signal,
    });
    signal?.throwIfAborted();
    return isGetDisplaysUnsupported(output.stdout) ? null : parseAndroidDisplayInfos(output.stdout);
  } catch (error) {
    if (isAbort(error, signal) || !isGetDisplaysUnsupported(error)) {
      throw error;
    }
    // An unsupported subcommand is a capability answer, not a failure: dumpsys is the fallback.
    logger.debug(`cmd display get-displays is unsupported; reading dumpsys display instead.`);
    return null;
  }
}

/** Private secondary displays may be absent from the shell caller's get-displays list. */
export async function readAndroidLogicalDisplays(
  adb: AdbCommandRunner,
  panels: readonly DisplayPanel[],
  signal?: AbortSignal,
): Promise<AndroidDisplayInfo[]> {
  const infos = await readGetDisplays(adb, signal);
  if (infos === null) {
    return readDumpsysLogicalDisplays(adb, signal);
  }
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
    const dump = await readDumpsysDisplay(adb, signal);
    // Reserve display 0 even when the primary list is empty; supplementation is secondary-only.
    const reportedIds = new Set(["0", ...infos.map((info) => info.logicalId)]);
    for (const info of parseDumpsysLogicalDisplays(dump)) {
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
