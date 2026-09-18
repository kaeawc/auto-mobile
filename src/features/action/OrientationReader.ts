import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { parseWindowManagerRotation } from "../../utils/android-cmdline-tools/parseWindowManagerRotation";
import { logger } from "../../utils/logger";

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
      if (rotation === 0 || rotation === 2) {
        return "portrait";
      }
      if (rotation === 1 || rotation === 3) {
        return "landscape";
      }
      return null;
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
