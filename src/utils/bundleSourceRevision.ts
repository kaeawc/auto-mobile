import {
  BUILD_GIT_BRANCH_KEY,
  BUILD_GIT_SHA_KEY,
  parseBuildSourceRevision,
  type BuildSourceRevision,
} from "../models/BuildSourceRevision";
import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
import type { PlistReader } from "./ios-cmdline-tools/PlistClient";

export type InfoPlistReader = Pick<PlistReader, "readJsonFile">;

/**
 * Read the git branch/sha an installed app bundle declares in its Info.plist
 * (#16954). Returns `undefined` when the bundle declares none, declares an invalid
 * pair, or its Info.plist cannot be read: the revision is optional display metadata.
 */
export async function readBundleSourceRevision(
  reader: InfoPlistReader,
  bundlePath: string,
): Promise<BuildSourceRevision | undefined> {
  if (!bundlePath) {
    return undefined;
  }
  let info: unknown;
  try {
    info = await reader.readJsonFile(`${bundlePath}/Info.plist`);
  } catch (error) {
    // Optional display metadata: an unreadable Info.plist keeps the version/hash label.
    logger.debug(
      `[BuildSourceRevision] Info.plist unreadable at ${bundlePath}: ${errorMessage(error)}`,
    );
    return undefined;
  }
  if (typeof info !== "object" || info === null) {
    return undefined;
  }
  const record = info as Record<string, unknown>;
  return parseBuildSourceRevision(record[BUILD_GIT_BRANCH_KEY], record[BUILD_GIT_SHA_KEY]);
}
