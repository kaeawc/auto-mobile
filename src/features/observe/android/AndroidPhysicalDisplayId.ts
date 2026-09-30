import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../../utils/SystemTimer";
import { defaultTimer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";

const SURFACE_FLINGER_DISPLAY_IDS_COMMAND = "shell dumpsys SurfaceFlinger --display-id";
const DEFAULT_DISPLAY_INFO_COMMAND = "shell cmd display get-displays";
export const PHYSICAL_DISPLAY_ID_CACHE_TTL_MS = 10_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function assertValidPng(buffer: Buffer): void {
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Screencap output is not a valid PNG (missing PNG signature)");
  }
}

/**
 * Per-device display resolution cache. Single-display and unambiguous
 * multi-display results are cached; unavailable or ambiguous results are retried.
 */
export class AndroidPhysicalDisplayIdResolver {
  private readonly cache = new Map<string, { displayId: string | null; expiresAt: number }>();

  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly ttlMs: number = PHYSICAL_DISPLAY_ID_CACHE_TTL_MS,
  ) {}

  async resolve(adb: AdbExecutor, deviceId: string): Promise<string | null> {
    const cached = this.cache.get(deviceId);
    if (cached && cached.expiresAt > this.timer.now()) {
      return cached.displayId;
    }
    this.cache.delete(deviceId);
    const result = await resolvePhysicalDisplay(adb);
    if (result.kind === "single" || result.kind === "display") {
      const displayId = result.kind === "display" ? result.id : null;
      this.cache.set(deviceId, { displayId, expiresAt: this.timer.now() + this.ttlMs });
      return displayId;
    }
    return null;
  }
}

/** Resolve the active logical default display to a physical SurfaceFlinger ID. */
export async function resolveActivePhysicalDisplayId(adb: AdbExecutor): Promise<string | null> {
  const result = await resolvePhysicalDisplay(adb);
  return result.kind === "display" ? result.id : null;
}

type PhysicalDisplayResolution =
  | { kind: "single" }
  | { kind: "display"; id: string }
  | { kind: "unresolved" };

async function resolvePhysicalDisplay(adb: AdbExecutor): Promise<PhysicalDisplayResolution> {
  try {
    const [surfaceFlinger, displayInfo] = await Promise.all([
      adb.executeCommand(SURFACE_FLINGER_DISPLAY_IDS_COMMAND),
      adb.executeCommand(DEFAULT_DISPLAY_INFO_COMMAND),
    ]);
    const physicalIds = parseSurfaceFlingerDisplayIds(surfaceFlinger.stdout);

    // A single physical display needs no explicit selection and keeps the
    // existing screencap command unchanged.
    if (physicalIds.length === 1) {
      return { kind: "single" };
    }
    if (physicalIds.length === 0) {
      return { kind: "unresolved" };
    }

    const defaultPhysicalId = parseDefaultDisplayPhysicalId(displayInfo.stdout);
    return defaultPhysicalId !== null && physicalIds.includes(defaultPhysicalId)
      ? { kind: "display", id: defaultPhysicalId }
      : { kind: "unresolved" };
  } catch (error) {
    // Display discovery is optional; preserve the legacy capture path when a
    // device does not support either diagnostic command.
    logger.debug(`[AndroidPhysicalDisplayId] Display discovery failed: ${error}`);
    return { kind: "unresolved" };
  }
}

function parseSurfaceFlingerDisplayIds(output: string): string[] {
  const ids = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const tokens = line.trim().split(/[\s():]+/);
    if (tokens[0] === "Display" && /^\d+$/.test(tokens[1] ?? "")) {
      ids.add(tokens[1]);
    }
  }
  return [...ids];
}

function parseDefaultDisplayPhysicalId(output: string): string | null {
  let physicalId: string | null = null;
  let foundDefaultDisplay = false;
  for (const line of output.split(/\r?\n/)) {
    const header = line.trim().split(/\s+/, 4);
    if (header[0] !== "Display" || header[1] !== "id" || header[2] !== "0:") {
      continue;
    }
    if (foundDefaultDisplay) {
      return null;
    }
    foundDefaultDisplay = true;
    const tokens = line
      .trim()
      .split(/[\s"{},]+/)
      .filter(Boolean);
    const uniqueIdIndex = tokens.findIndex((token) => token === "uniqueId");
    const uniqueId = uniqueIdIndex >= 0 ? tokens[uniqueIdIndex + 1] : undefined;
    const match = uniqueId?.match(/^local:(\d+)$/);
    physicalId = match?.[1] ?? null;
  }
  return physicalId;
}
