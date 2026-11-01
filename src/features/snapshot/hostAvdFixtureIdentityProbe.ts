import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ENV, readEnvRaw } from "../../config/env";
import { ActionableError } from "../../models/ActionableError";
import { AndroidEmulatorClient } from "../../utils/android-cmdline-tools/AndroidEmulatorClient";
import { FileAvdConfigReader } from "../../utils/android-cmdline-tools/AvdConfigReader";
import { getAndroidHomeWithSystemImages } from "../../utils/android-cmdline-tools/detection";
import { parseExtraEmulatorArguments } from "../../utils/android-cmdline-tools/EmulatorLaunchSupport";
import { logger } from "../../utils/logger";
import { AvdFixtureIdentityProbe, USERDATA_IMAGE } from "./avdFixtureIdentityProbe";

const EMULATOR_VERSION_TIMEOUT_MS = 10_000;

/** The fixture identity probe over this host's real AVD files, SDK and emulator binary (#14065). */
export function createHostAvdFixtureIdentityProbe(): AvdFixtureIdentityProbe {
  const avds = new FileAvdConfigReader();
  const emulator = new AndroidEmulatorClient();
  return new AvdFixtureIdentityProbe({
    config: avds,
    avdDirectory: avds,
    imageMetadata: async (imagePath) =>
      readFile(
        systemImageMetadataPath(
          imagePath,
          isAbsolute(imagePath) ? undefined : getAndroidHomeWithSystemImages()?.androidHome,
        ),
        "utf8",
      ),
    userdataImage: (avdDirectory) => userdataImagePath(avdDirectory, readEnvRaw(ENV.EMULATOR_ARGS)),
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

/**
 * The installed system image's `source.properties`. An absolute `image.sysdir.1` is read where it
 * is; a relative one needs the SDK root it is relative to.
 */
export function systemImageMetadataPath(imagePath: string, sdkRoot: string | undefined): string {
  if (isAbsolute(imagePath)) {
    return join(imagePath, "source.properties");
  }
  if (!sdkRoot) {
    throw new ActionableError("A snapshot fixture needs installed system-image metadata");
  }
  return resolve(sdkRoot, imagePath, "source.properties");
}

/**
 * The userdata image the emulator runs, and `-wipe-data` re-creates: the AVD's own, unless
 * `AUTOMOBILE_EMULATOR_ARGS` redirects it with `-data`, which every launch then follows.
 */
export function userdataImagePath(
  avdDirectory: string,
  rawEmulatorArgs: string | undefined,
): string {
  const args = rawEmulatorArgs ? parseExtraEmulatorArguments(rawEmulatorArgs) : [];
  const flag = args.indexOf("-data");
  if (flag === -1) {
    return join(avdDirectory, USERDATA_IMAGE);
  }
  const override = args[flag + 1];
  if (!override || override.startsWith("-")) {
    throw new ActionableError(
      "AUTOMOBILE_EMULATOR_ARGS passes -data without a path, so a fixture cannot tell which userdata image the emulator runs",
    );
  }
  return override;
}
