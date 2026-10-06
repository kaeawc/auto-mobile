import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readWindowManagerRotation } from "../../utils/android-cmdline-tools/readWindowManagerRotation";
import { logger } from "../../utils/logger";

/**
 * The single definition of which WindowManager rotation value is portrait on a
 * display: the natural orientation (`wm size` physical width > height) decides
 * whether rotations 0/2 or 1/3 are the portrait pair. `null` (size unreadable)
 * keeps the historical portrait-natural mapping.
 */
export function orientationFromRotation(
  rotation: number,
  naturalLandscape: boolean | null,
): "portrait" | "landscape" | null {
  if (![0, 1, 2, 3].includes(rotation)) {
    return null;
  }
  const naturalAxesLandscape = naturalLandscape ?? false;
  const rotatedFromNaturalAxes = rotation === 1 || rotation === 3;
  return naturalAxesLandscape === rotatedFromNaturalAxes ? "portrait" : "landscape";
}

/**
 * The `user_rotation` value that holds `orientation` on a display with the
 * given natural orientation; the inverse of {@link orientationFromRotation}
 * for the unreversed rotations 0 and 1.
 */
export function rotationForOrientation(
  orientation: "portrait" | "landscape",
  naturalLandscape: boolean | null,
): 0 | 1 {
  return (orientation === "landscape") === (naturalLandscape ?? false) ? 0 : 1;
}

/**
 * Whether the active display's natural (rotation 0) orientation is landscape,
 * from `wm size`'s physical size. Returns null when the size cannot be read.
 * Read it fresh per request: a fold or unfold changes which panel is active.
 */
export async function readNaturalLandscape(
  adb: Pick<AdbExecutor, "executeCommand">,
  signal?: AbortSignal,
): Promise<boolean | null> {
  try {
    const { stdout } = await adb.executeCommand(
      "shell wm size",
      undefined,
      undefined,
      undefined,
      signal,
    );
    // Keep this parser aligned with AxisRanges.ts's queryDisplaySize parser.
    const size = stdout.match(/Physical size:\s*(\d+)x(\d+)/);
    return size ? Number(size[1]) > Number(size[2]) : null;
  } catch (error) {
    // A size probe is best effort; rotation alone still provides the prior answer.
    logger.debug(`[OrientationReader] Failed to read natural display size: ${error}`);
    return null;
  }
}

export interface OrientationReader {
  readOrientation(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<"portrait" | "landscape" | null>;
}

/** Reads Android's live WindowManager rotation through an injected ADB executor. */
export class AndroidOrientationReader implements OrientationReader {
  constructor(private readonly adb: AdbExecutor) {}

  async readOrientation(
    _device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<"portrait" | "landscape" | null> {
    try {
      const rotation = await readWindowManagerRotation(this.adb, { signal });
      if (rotation === null) {
        return null;
      }

      const naturalLandscape = await readNaturalLandscape(this.adb, signal);
      return orientationFromRotation(rotation, naturalLandscape);
    } catch (error) {
      logger.debug(`[OrientationReader] Failed to read Android orientation: ${error}`);
      return null;
    }
  }
}

/**
 * CtrlProxy exposes orientation only as part of its rotate response; it has no
 * read-only orientation query, so this seam cannot safely report an iOS value yet.
 */
export class IosOrientationReader implements OrientationReader {
  async readOrientation(
    _device: BootedDevice,
    _signal?: AbortSignal,
  ): Promise<"portrait" | "landscape" | null> {
    return null;
  }
}
