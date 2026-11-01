import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { ActionableError } from "../../models/ActionableError";
import { AndroidEmulatorClient } from "../../utils/android-cmdline-tools/AndroidEmulatorClient";
import { FileAvdConfigReader } from "../../utils/android-cmdline-tools/AvdConfigReader";
import { getAndroidHomeWithSystemImages } from "../../utils/android-cmdline-tools/detection";
import { logger } from "../../utils/logger";
import { AvdFixtureIdentityProbe } from "./avdFixtureIdentityProbe";

const EMULATOR_VERSION_TIMEOUT_MS = 10_000;

/** The fixture identity probe over this host's real AVD files, SDK and emulator binary (#14065). */
export function createHostAvdFixtureIdentityProbe(): AvdFixtureIdentityProbe {
  const avds = new FileAvdConfigReader();
  const emulator = new AndroidEmulatorClient();
  return new AvdFixtureIdentityProbe({
    config: avds,
    avdDirectory: avds,
    imageMetadata: async (imagePath) => {
      const sdk = getAndroidHomeWithSystemImages();
      if (!sdk) {
        throw new ActionableError("A snapshot fixture needs installed system-image metadata");
      }
      return readFile(resolve(sdk.androidHome, imagePath, "source.properties"), "utf8");
    },
    emulatorVersion: async () => {
      const result = await emulator.executeCommand(["-version"], EMULATOR_VERSION_TIMEOUT_MS);
      return result.error ? "" : result.stdout;
    },
    fileIdentity: (path) => readFileIdentity(path),
  });
}

/** Inode and birth time of `path`, or null when it does not exist. Other errors propagate. */
export async function readFileIdentity(
  path: string,
  statFile: (path: string) => Promise<{ ino: number; birthtimeMs: number }> = stat,
): Promise<{ ino: number; birthtimeMs: number } | null> {
  try {
    const info = await statFile(path);
    return { ino: info.ino, birthtimeMs: info.birthtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // No userdata image yet: the AVD has never booted, which the identity records as "none".
    logger.debug(`[DeviceSnapshot] no userdata image at ${path}`);
    return null;
  }
}
