import { join } from "node:path";
import { FileAvdConfigReader, type AvdDirectoryResolver } from "./AvdConfigReader";
import { DefaultFileSystem, type FileSystem } from "../filesystem/DefaultFileSystem";
import { logger } from "../logger";

/** One pending cold boot per AVD, persisted across daemon restarts. */
export interface AvdColdBootMarkerStore {
  isMarked(avdName: string): Promise<boolean>;
  /** Resolves false, writing nothing, when `avdName` names no AVD directory on this host. */
  mark(avdName: string): Promise<boolean>;
  clear(avdName: string): Promise<void>;
}

export const AVD_COLD_BOOT_MARKER = ".automobile-cold-boot";

export class FileAvdColdBootMarkerStore implements AvdColdBootMarkerStore {
  constructor(
    private readonly directories: AvdDirectoryResolver = new FileAvdConfigReader(),
    private readonly files: Pick<
      FileSystem,
      "readFile" | "writeFile" | "unlink"
    > = new DefaultFileSystem(),
  ) {}

  private async markerPath(avdName: string): Promise<string> {
    const directory = await this.directories.resolveAvdDirectory(avdName);
    if (!directory) {
      throw new Error(`Cannot resolve AVD directory for '${avdName}'`);
    }
    return join(directory, AVD_COLD_BOOT_MARKER);
  }

  async isMarked(avdName: string): Promise<boolean> {
    const target = await this.markerPath(avdName);
    try {
      await this.files.readFile(target);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        // An absent marker is the ordinary quickboot path.
        logger.debug(`No cold boot marker for AVD '${avdName}'`);
        return false;
      }
      throw error;
    }
  }

  async mark(avdName: string): Promise<boolean> {
    const directory = await this.directories.resolveAvdDirectory(avdName);
    if (!directory) {
      return false;
    }
    await this.files.writeFile(
      join(directory, AVD_COLD_BOOT_MARKER),
      "Android Auto projection stopped\n",
    );
    return true;
  }

  async clear(avdName: string): Promise<void> {
    const target = await this.markerPath(avdName);
    try {
      await this.files.unlink(target);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        // Clearing an already consumed marker is harmless.
        logger.debug(`Cold boot marker already absent for AVD '${avdName}'`);
        return;
      }
      throw error;
    }
  }
}
