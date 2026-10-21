import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";

interface OwnedFileRemovalFiles {
  rename(from: string, to: string): void;
  link(from: string, to: string): void;
  remove(path: string): void;
}

/** Returns false for a displaced successor; true for our removal or an absent path. */
export function removeOwnedFileSync(
  path: string,
  owns: (claimedPath: string) => boolean,
  files: OwnedFileRemovalFiles,
  ids: IdGenerator = defaultIdGenerator,
): boolean {
  const claimedPath = `${path}.reap-${process.pid}-${ids.next()}`;
  try {
    // Claim a single directory entry; later atomic publications remain at path.
    files.rename(path, claimedPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // Another cleanup already removed the entry; there is nothing left to claim.
      logger.debug(`Owner record already absent at ${path}: ${errorMessage(error)}`);
      return true;
    }
    logger.warn(`Unable to claim owner record at ${path}: ${errorMessage(error)}`, error);
    throw error;
  }

  if (owns(claimedPath)) {
    files.remove(claimedPath);
    return true;
  }

  try {
    // A hard link restores only into an empty path, never over a newer publication.
    files.link(claimedPath, path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      // Preserve the displaced record for recovery if restoration itself is unavailable.
      logger.warn(`Owner record retained at ${claimedPath}: ${errorMessage(error)}`, error);
      throw error;
    }
    // EEXIST proves a newer entry occupies the public path; the displaced entry is obsolete.
    logger.debug(`Owner record restore destination occupied at ${path}: ${errorMessage(error)}`);
  }
  files.remove(claimedPath);
  return false;
}
