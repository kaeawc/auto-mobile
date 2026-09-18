import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { parseWindowManagerRotation } from "../../utils/android-cmdline-tools/parseWindowManagerRotation";
import { logger } from "../../utils/logger";

function orientationFromRotation(
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

export interface OrientationReader {
  readOrientation(device: BootedDevice): Promise<"portrait" | "landscape" | null>;
}

/** Reads Android's live WindowManager rotation through an injected ADB executor. */
export class AndroidOrientationReader implements OrientationReader {
  constructor(private readonly adb: AdbExecutor) {}

  async readOrientation(_device: BootedDevice): Promise<"portrait" | "landscape" | null> {
    try {
      const { stdout } = await this.adb.executeCommand(
        'shell dumpsys window | grep -i "mRotation="',
      );
      const rotation = parseWindowManagerRotation(stdout);
      if (rotation === null) {
        return null;
      }

      let naturalLandscape: boolean | null = null;
      try {
        const { stdout: sizeOutput } = await this.adb.executeCommand("shell wm size");
        // Keep this parser aligned with AxisRanges.ts's queryDisplaySize parser.
        const size = sizeOutput.match(/Physical size:\s*(\d+)x(\d+)/);
        if (size) {
          naturalLandscape = Number(size[1]) > Number(size[2]);
        }
      } catch (error) {
        // A size probe is best effort; rotation alone still provides the prior answer.
        logger.debug(`[OrientationReader] Failed to read natural display size: ${error}`);
      }

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
export class IOSOrientationReader implements OrientationReader {
  async readOrientation(_device: BootedDevice): Promise<"portrait" | "landscape" | null> {
    return null;
  }
}
