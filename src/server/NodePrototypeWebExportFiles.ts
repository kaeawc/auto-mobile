import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { logger } from "../utils/logger";
import { getTempDir } from "../utils/tempDir";
import type { PrototypeWebExportFiles, PrototypeWebExportPathKind } from "./prototypeWebExport";

const FILE_MODE = 0o644;

/** Exported pages live under the AutoMobile data directory by default, outliving temp cleanup. */
export class NodePrototypeWebExportFiles implements PrototypeWebExportFiles {
  constructor(private readonly ids: IdGenerator = defaultIdGenerator) {}

  defaultDir(): string {
    return getTempDir("prototype-web");
  }

  async kind(filePath: string): Promise<PrototypeWebExportPathKind | undefined> {
    try {
      const stats = await stat(filePath);
      if (stats.isFile()) {
        return "file";
      }
      return stats.isDirectory() ? "directory" : "other";
    } catch (error) {
      // A missing path is the normal case for a new export; an unreadable one fails at write.
      logger.debug(`prototype web export: stat ${filePath} failed`, error);
      return undefined;
    }
  }

  async read(filePath: string): Promise<Uint8Array> {
    return await readFile(filePath);
  }

  /**
   * An exclusive write creates the file (O_EXCL also refuses a symlink there). A replacing write
   * goes to a private temp file in the same directory and is renamed over the path, so a symlink
   * at the path is replaced rather than written through, and readers never see a partial page.
   */
  async write(filePath: string, bytes: Uint8Array, options: { exclusive: boolean }): Promise<void> {
    const directory = dirname(filePath);
    await mkdir(directory, { recursive: true });
    if (options.exclusive) {
      await writeFile(filePath, bytes, { flag: "wx", mode: FILE_MODE });
      return;
    }
    // Independent of the target name, so a long valid basename cannot push it past NAME_MAX.
    const tempPath = join(directory, `.automobile-export-${this.ids.next()}.tmp`);
    try {
      await writeFile(tempPath, bytes, { flag: "wx", mode: FILE_MODE });
      await rename(tempPath, filePath);
    } catch (error) {
      await removeTemp(tempPath);
      throw error;
    }
  }
}

async function removeTemp(tempPath: string): Promise<void> {
  try {
    await rm(tempPath, { force: true });
  } catch (error) {
    // The write already failed and is reported; a leftover dot-temp file is only clutter.
    logger.debug(`prototype web export: removing ${tempPath} failed`, error);
  }
}
