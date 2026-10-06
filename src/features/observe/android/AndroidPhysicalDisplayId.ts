import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../../utils/SystemTimer";
import { defaultTimer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import { ActionableError } from "../../../models/ActionableError";
import { displayTransitions } from "../DisplayTransition";
import {
  parseAndroidDisplayInfos,
  parseSurfaceFlingerDisplayIds,
  physicalDisplayIdForLogicalId,
} from "../../../utils/android-cmdline-tools/AndroidDisplayParsers";

const SURFACE_FLINGER_DISPLAY_IDS_COMMAND = "shell dumpsys SurfaceFlinger --display-id";
const DEFAULT_DISPLAY_INFO_COMMAND = "shell cmd display get-displays";
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

/**
 * Per-device display resolution cache. Single-display and unambiguous
 * multi-display results are cached for the host display revision; unavailable
 * or ambiguous results are retried.
 */
export class AndroidPhysicalDisplayIdResolver {
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
      options.displayRevision ?? ((deviceId) => displayTransitions.revision(deviceId));
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
   * Resolve an Android logical display id (as listed by `cmd display
   * get-displays`) to the physical id `screencap -d` takes. Returns null when
   * the list is unreadable or the display has no `local:` physical id; the
   * caller decides how to proceed, because the logical id itself is rejected by
   * `screencap -d`. A cached list that lacks the requested id is refetched once
   * (a hot-plugged display or a lagging fold transition), never more.
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
    const physicalId = infos ? physicalDisplayIdForLogicalId(infos, logicalId) : undefined;
    if (infos && physicalId === undefined) {
      logger.warn(
        `[AndroidPhysicalDisplayId] Logical display ${logicalId} has no physical display id in the display list`,
      );
    }
    return physicalId ?? null;
  }

  private async readLogicalDisplayInfos(
    adb: AdbExecutor,
    deviceId: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseAndroidDisplayInfos> | null> {
    try {
      const output = await adb.executeCommand(
        DEFAULT_DISPLAY_INFO_COMMAND,
        undefined,
        undefined,
        undefined,
        signal,
      );
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
      adb.executeCommand(
        SURFACE_FLINGER_DISPLAY_IDS_COMMAND,
        undefined,
        undefined,
        undefined,
        signal,
      ),
      adb.executeCommand(DEFAULT_DISPLAY_INFO_COMMAND, undefined, undefined, undefined, signal),
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
