import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../../utils/SystemTimer";
import { defaultTimer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import { ActionableError } from "../../../models/ActionableError";
import { displayTransitions } from "../DisplayTransition";
import {
  parseAndroidDisplayInfos,
  parseDumpsysLogicalDisplays,
  parseSurfaceFlingerDisplayIds,
  physicalDisplayIdForLogicalId,
  type AndroidDisplayInfo,
} from "../../../utils/android-cmdline-tools/AndroidDisplayParsers";
import { DUMPSYS_MAX_BUFFER } from "../../../utils/android-cmdline-tools/dumpsysLimits";
import { errorMessage } from "../../../utils/describeUnknownError";

const SURFACE_FLINGER_DISPLAY_IDS_COMMAND = "shell dumpsys SurfaceFlinger --display-id";
const DEFAULT_DISPLAY_INFO_COMMAND = "shell cmd display get-displays";
const DUMPSYS_DISPLAY_COMMAND = "shell dumpsys display";
const DUMPSYS_DISPLAY_TIMEOUT_MS = 2000;
export const PHYSICAL_DISPLAY_ID_CACHE_TTL_MS = 10_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const screenshotCaptureTails = new Map<string, Promise<void>>();

/** Serialize device-side screenshot captures so Android's capture pipeline is not overlapped. */
export async function withAndroidScreenshotCaptureLock<T>(
  deviceId: string,
  capture: () => Promise<T>,
): Promise<T> {
  const previous = screenshotCaptureTails.get(deviceId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  screenshotCaptureTails.set(deviceId, tail);

  await previous;
  try {
    return await capture();
  } finally {
    release();
    if (screenshotCaptureTails.get(deviceId) === tail) {
      screenshotCaptureTails.delete(deviceId);
    }
  }
}

export function assertValidPng(buffer: Buffer): void {
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ActionableError(
      "Android screencap returned data without a PNG signature; verify the device display and retry the screenshot.",
    );
  }
}

/** Remove warning text that some Android builds print before screencap output. */
export function stripLeadingPngNoise(buffer: Buffer): Buffer {
  const signatureIndex = buffer.indexOf(PNG_SIGNATURE);
  if (signatureIndex < 0) {
    assertValidPng(buffer);
  }
  return buffer.subarray(signatureIndex);
}

/** Decode base64 screencap output after discarding any plain-text warning prefix. */
export function decodePngBase64Output(output: string): Buffer {
  const cleanedOutput = output.replace(/[\r\n]/g, "");
  const signatureOffset = cleanedOutput.indexOf("iVBORw0KGgo");
  if (signatureOffset < 0) {
    assertValidPng(Buffer.from(cleanedOutput, "base64"));
  }
  return stripLeadingPngNoise(Buffer.from(cleanedOutput.slice(signatureOffset), "base64"));
}

/** What a screenshot capture needs from display resolution (fakes implement this). */
export interface PhysicalDisplayIdResolver {
  resolve(adb: AdbExecutor, deviceId: string, signal?: AbortSignal): Promise<string | null>;
  resolveLogical(
    adb: AdbExecutor,
    deviceId: string,
    logicalId: number,
    signal?: AbortSignal,
  ): Promise<string | null>;
}

/**
 * Per-device display resolution cache. Single-display and unambiguous
 * multi-display results are cached for the host display revision; unavailable
 * or ambiguous results are retried.
 */
export class AndroidPhysicalDisplayIdResolver implements PhysicalDisplayIdResolver {
  private readonly cache = new Map<
    string,
    { displayId: string | null; expiresAt: number; revision: number }
  >();
  private readonly logicalCache = new Map<
    string,
    {
      infos: ReturnType<typeof parseAndroidDisplayInfos>;
      expiresAt: number;
      revision: number;
    }
  >();
  private readonly timer: Timer;
  private readonly ttlMs: number;
  private readonly displayRevision: (deviceId: string) => number;

  constructor(
    options: {
      timer?: Timer;
      ttlMs?: number;
      displayRevision?: (deviceId: string) => number;
    } = {},
  ) {
    this.timer = options.timer ?? defaultTimer;
    this.ttlMs = options.ttlMs ?? PHYSICAL_DISPLAY_ID_CACHE_TTL_MS;
    this.displayRevision =
      options.displayRevision ?? ((deviceId) => displayTransitions.displayStateRevision(deviceId));
  }

  async resolve(adb: AdbExecutor, deviceId: string, signal?: AbortSignal): Promise<string | null> {
    const revision = this.displayRevision(deviceId);
    const cached = this.cache.get(deviceId);
    if (cached && cached.expiresAt > this.timer.now() && cached.revision === revision) {
      return cached.displayId;
    }
    this.cache.delete(deviceId);
    const result = await resolvePhysicalDisplay(adb, signal);
    if (result.kind === "single" || result.kind === "display") {
      const displayId = result.kind === "display" ? result.id : null;
      // Keep the revision captured before discovery so a transition during
      // the lookup prevents its result from serving a later caller.
      this.cache.set(deviceId, { displayId, expiresAt: this.timer.now() + this.ttlMs, revision });
      return displayId;
    }
    return null;
  }

  /**
   * Resolve an Android logical display id to the physical id `screencap -d`
   * takes. `cmd display get-displays` is read first; a display it does not
   * list (an AAOS FLAG_PRIVATE cluster panel is hidden from the shell caller,
   * #17740) is then looked up in `dumpsys display`'s Logical Displays section,
   * which includes private displays. Returns null when neither source gives the
   * display a `local:` physical id; the caller decides how to proceed, because
   * the logical id itself is rejected by `screencap -d`. A cached list that
   * lacks the requested id is refetched once (a hot-plugged display or a
   * lagging fold transition), never more.
   */
  async resolveLogical(
    adb: AdbExecutor,
    deviceId: string,
    logicalId: number,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const revision = this.displayRevision(deviceId);
    const cached = this.logicalCache.get(deviceId);
    if (cached && cached.expiresAt > this.timer.now() && cached.revision === revision) {
      const hit = physicalDisplayIdForLogicalId(cached.infos, logicalId);
      if (hit !== undefined) {
        return hit;
      }
    }
    this.logicalCache.delete(deviceId);
    const infos = await this.readLogicalDisplayInfos(adb, deviceId, revision, signal);
    // Default display 0 is never private, and plain screencap already captures it.
    if (logicalId === 0 || infos?.some((info) => info.logicalId === String(logicalId))) {
      return listedPhysicalDisplayId(infos, logicalId);
    }
    return this.resolveHiddenLogical({ adb, deviceId, logicalId, revision, listed: infos, signal });
  }

  /** Resolve a display absent from `get-displays` from `dumpsys display`'s private records. */
  private async resolveHiddenLogical(request: HiddenLogicalDisplayRequest): Promise<string | null> {
    const { deviceId, logicalId, listed } = request;
    const hidden = await this.readDumpsysLogicalDisplay(request.adb, logicalId, request.signal);
    const physicalId = hidden ? physicalDisplayIdForLogicalId([hidden], logicalId) : undefined;
    if (hidden === undefined || physicalId === undefined) {
      logger.warn(
        `[AndroidPhysicalDisplayId] Logical display ${logicalId} has no physical display id in "cmd display get-displays" or "dumpsys display"`,
      );
      return null;
    }
    if (listed && listed.length > 0) {
      // Cache the supplemented list so repeat captures of the hidden display skip both reads.
      this.logicalCache.set(deviceId, {
        infos: [...listed, hidden],
        expiresAt: this.timer.now() + this.ttlMs,
        revision: request.revision,
      });
    }
    return physicalId;
  }

  /** The enabled `dumpsys display` Logical Displays record for one id, or undefined. */
  private async readDumpsysLogicalDisplay(
    adb: AdbExecutor,
    logicalId: number,
    signal?: AbortSignal,
  ): Promise<AndroidDisplayInfo | undefined> {
    try {
      const output = await adb.executeCommand(DUMPSYS_DISPLAY_COMMAND, {
        signal,
        timeoutMs: DUMPSYS_DISPLAY_TIMEOUT_MS,
        maxBuffer: DUMPSYS_MAX_BUFFER,
        noRetry: true,
      });
      return parseDumpsysLogicalDisplays(output.stdout).find(
        (info) => info.logicalId === String(logicalId),
      );
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(
        `[AndroidPhysicalDisplayId] dumpsys display lookup failed: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  private async readLogicalDisplayInfos(
    adb: AdbExecutor,
    deviceId: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<AndroidDisplayInfo[] | null> {
    try {
      const output = await adb.executeCommand(DEFAULT_DISPLAY_INFO_COMMAND, { signal });
      const infos = parseAndroidDisplayInfos(output.stdout);
      if (infos.length > 0) {
        this.logicalCache.set(deviceId, {
          infos,
          expiresAt: this.timer.now() + this.ttlMs,
          revision,
        });
      }
      return infos;
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[AndroidPhysicalDisplayId] Logical display lookup failed: ${error}`, error);
      return null;
    }
  }
}

interface HiddenLogicalDisplayRequest {
  adb: AdbExecutor;
  deviceId: string;
  logicalId: number;
  /** The revision captured before discovery, so a transition during the lookup is not cached. */
  revision: number;
  /** The `get-displays` records, or null when that list was unreadable. */
  listed: AndroidDisplayInfo[] | null;
  signal?: AbortSignal;
}

function listedPhysicalDisplayId(
  infos: readonly AndroidDisplayInfo[] | null,
  logicalId: number,
): string | null {
  if (infos === null) {
    // readLogicalDisplayInfos already logged why the list is unreadable.
    return null;
  }
  const physicalId = physicalDisplayIdForLogicalId(infos, logicalId);
  if (physicalId === undefined) {
    logger.warn(
      `[AndroidPhysicalDisplayId] Logical display ${logicalId} has no physical display id in the display list`,
    );
  }
  return physicalId ?? null;
}

type PhysicalDisplayResolution =
  | { kind: "single" }
  | { kind: "display"; id: string }
  | { kind: "unresolved" };

async function resolvePhysicalDisplay(
  adb: AdbExecutor,
  signal?: AbortSignal,
): Promise<PhysicalDisplayResolution> {
  try {
    const [surfaceFlinger, displayInfo] = await Promise.all([
      adb.executeCommand(SURFACE_FLINGER_DISPLAY_IDS_COMMAND, { signal }),
      adb.executeCommand(DEFAULT_DISPLAY_INFO_COMMAND, { signal }),
    ]);
    const physicalIds = parseSurfaceFlingerDisplayIds(surfaceFlinger.stdout);

    // A single physical display needs no explicit selection and keeps the
    // existing screencap command unchanged.
    if (physicalIds.size === 1) {
      return { kind: "single" };
    }
    if (physicalIds.size === 0) {
      return { kind: "unresolved" };
    }

    const defaultPhysicalId = parseDefaultDisplayPhysicalId(displayInfo.stdout);
    return defaultPhysicalId !== null && physicalIds.has(defaultPhysicalId)
      ? { kind: "display", id: defaultPhysicalId }
      : { kind: "unresolved" };
  } catch (error) {
    signal?.throwIfAborted();
    // Display discovery is optional; preserve the legacy capture path when a
    // device does not support either diagnostic command.
    logger.debug(`[AndroidPhysicalDisplayId] Display discovery failed: ${error}`);
    return { kind: "unresolved" };
  }
}

function parseDefaultDisplayPhysicalId(output: string): string | null {
  const defaults = parseAndroidDisplayInfos(output).filter((record) => record.logicalId === "0");
  if (defaults.length !== 1) {
    return null;
  }
  return /^local:(\d+)$/.exec(defaults[0].uniqueId ?? "")?.[1] ?? null;
}
