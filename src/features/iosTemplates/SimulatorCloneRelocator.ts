import { join } from "node:path";
import { ActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";

/**
 * A simulator's data directory records absolute paths that contain its own UDID: the
 * LaunchServices store (every system app's data-container URL), symlinks (`Library/Logs`,
 * Shortcuts, MobileAsset locks) and preference/state databases. `simctl clone` copies those
 * bytes verbatim, so a booted clone resolves Safari and the other system apps, and their
 * daemons, to the TEMPLATE's data directory (#15327). Both UDIDs have the same length, so
 * replacing the template UDID with the clone UDID in place keeps every file's layout intact.
 */
const UDID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
/** Unified-log archives only describe history; rewriting them would buy nothing. */
export const CLONE_RELOCATION_SKIP_DIRS: readonly string[] = ["var/db/diagnostics"];
const WAL_SUFFIX = "-wal";

export interface CloneRelocationScan {
  /** Regular files whose bytes contain the needle. */
  files: readonly string[];
  /** Symlinks (to files or directories) whose target contains the needle. */
  links: readonly string[];
}

export interface CloneRelocationFileSystem {
  scan(
    root: string,
    needle: string,
    skipDirs: readonly string[],
    signal?: AbortSignal,
  ): Promise<CloneRelocationScan>;
  exists(path: string): Promise<boolean>;
  fileContains(path: string, needle: string): Promise<boolean>;
  /** Replace every occurrence of `from` with the same-length `to`, in place. */
  replaceInFile(path: string, from: string, to: string): Promise<void>;
  retargetLink(path: string, from: string, to: string): Promise<void>;
}

export interface SqliteWalCheckpointer {
  /** Fold the write-ahead log into the database and truncate it. */
  checkpoint(databasePath: string, signal?: AbortSignal): Promise<void>;
}

export interface CloneRelocationRequest {
  templateUdid: string;
  cloneUdid: string;
  signal?: AbortSignal;
}

export interface CloneRelocationResult {
  rewrittenFiles: number;
  retargetedLinks: number;
  checkpointedDatabases: number;
}

export interface CloneRelocationDependencies {
  fs: CloneRelocationFileSystem;
  checkpointer: SqliteWalCheckpointer;
  /** Directory holding `<udid>/data` for the active CoreSimulator device set. */
  deviceSetRoot(): string;
}

export class SimulatorCloneRelocator {
  constructor(private readonly deps: CloneRelocationDependencies) {}

  /** Make a freshly cloned, shut-down simulator refer to itself instead of its template. */
  async relocate(request: CloneRelocationRequest): Promise<CloneRelocationResult> {
    const { templateUdid, cloneUdid, signal } = request;
    if (!UDID_PATTERN.test(templateUdid) || !UDID_PATTERN.test(cloneUdid)) {
      throw new ActionableError(
        `Cannot relocate clone ${cloneUdid} from template ${templateUdid}: both must be simulator UDIDs`,
      );
    }
    const { fs } = this.deps;
    const dataRoot = join(this.deps.deviceSetRoot(), cloneUdid, "data");
    const scan = await fs.scan(dataRoot, templateUdid, CLONE_RELOCATION_SKIP_DIRS, signal);
    // A WAL frame carries a checksum over its bytes, so fold logs into their databases first and
    // rewrite the databases, not the logs.
    const checkpointed = await this.checkpointWals(scan.files, signal);
    const files = await this.withCheckpointedDatabases(scan.files, checkpointed, templateUdid);
    for (const file of files) {
      signal?.throwIfAborted();
      await fs.replaceInFile(file, templateUdid, cloneUdid);
    }
    for (const link of scan.links) {
      signal?.throwIfAborted();
      await fs.retargetLink(link, templateUdid, cloneUdid);
    }
    return {
      rewrittenFiles: files.length,
      retargetedLinks: scan.links.length,
      checkpointedDatabases: checkpointed.length,
    };
  }

  private async checkpointWals(files: readonly string[], signal?: AbortSignal): Promise<string[]> {
    const checkpointed: string[] = [];
    for (const wal of files.filter((file) => file.endsWith(WAL_SUFFIX))) {
      signal?.throwIfAborted();
      const database = wal.slice(0, -WAL_SUFFIX.length);
      if (!(await this.deps.fs.exists(database))) {
        continue;
      }
      try {
        await this.deps.checkpointer.checkpoint(database, signal);
        checkpointed.push(database);
      } catch (error) {
        signal?.throwIfAborted();
        // The rewrite below discards the log's frames on a checksum mismatch, which loses only
        // uncheckpointed cache rows and keeps the database consistent; isolation still holds.
        logger.warn(`WAL checkpoint failed for ${database}: ${errorMessage(error)}`, error);
      }
    }
    return checkpointed;
  }

  private async withCheckpointedDatabases(
    files: readonly string[],
    checkpointed: readonly string[],
    needle: string,
  ): Promise<string[]> {
    const known = new Set(files);
    const result = [...files];
    for (const database of checkpointed) {
      if (!known.has(database) && (await this.deps.fs.fileContains(database, needle))) {
        result.push(database);
      }
    }
    return result;
  }
}
