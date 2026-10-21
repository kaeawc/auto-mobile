import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";

export interface OwnedFileRemovalFiles {
  rename(from: string, to: string): void;
  link(from: string, to: string): void;
  /** Copies into a new file; fails with EEXIST instead of overwriting a destination. */
  copyExclusive(from: string, to: string): void;
  remove(path: string): void;
}

export class OwnedRecordRestoreError extends Error {
  constructor(
    readonly path: string,
    readonly retainedPath: string,
    override readonly cause: unknown,
  ) {
    super(
      `Unable to restore owner record at ${path}; retained at ${retainedPath}: ${errorMessage(cause)}`,
    );
    this.name = "OwnedRecordRestoreError";
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function restoreByCopy(path: string, claimedPath: string, files: OwnedFileRemovalFiles): void {
  try {
    files.copyExclusive(claimedPath, path);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      // A newer publication occupies the public path, so the displaced copy is obsolete.
      logger.debug(`Owner record copy destination occupied at ${path}: ${errorMessage(error)}`);
      return;
    }
    logger.warn(`Owner record retained at ${claimedPath}: ${errorMessage(error)}`, error);
    throw new OwnedRecordRestoreError(path, claimedPath, error);
  }
}

function restoreDisplacedRecord(
  path: string,
  claimedPath: string,
  files: OwnedFileRemovalFiles,
): void {
  try {
    // A hard link restores only into an empty path, never over a newer publication.
    files.link(claimedPath, path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      // EEXIST proves a newer entry occupies the public path; the displaced entry is obsolete.
      logger.debug(`Owner record restore destination occupied at ${path}: ${errorMessage(error)}`);
      return;
    }
    if (
      code !== undefined &&
      ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK"].includes(code)
    ) {
      // Hard links are unavailable here; exclusive copy can safely restore without overwriting.
      logger.debug(`Owner record hard link unavailable at ${path}: ${errorMessage(error)}`);
      restoreByCopy(path, claimedPath, files);
      return;
    }
    logger.warn(`Owner record retained at ${claimedPath}: ${errorMessage(error)}`, error);
    throw new OwnedRecordRestoreError(path, claimedPath, error);
  }
}

/**
 * Returns false for a displaced successor; true for our removal or an absent path.
 * A successor's public path is absent only on the race path: publication between the
 * caller's final ownership read and the claim rename, for the duration of one restore.
 * POSIX has no atomic "unlink only if inode == X", and Node exposes no rename-noreplace;
 * closing that window requires publisher cooperation.
 */
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
    if (errorCode(error) === "ENOENT") {
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

  restoreDisplacedRecord(path, claimedPath, files);
  files.remove(claimedPath);
  return false;
}
