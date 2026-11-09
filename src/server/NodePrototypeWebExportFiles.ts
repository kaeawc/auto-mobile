import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../utils/logger";
import { getTempDir } from "../utils/tempDir";
import type { PrototypeWebExportFiles, PrototypeWebExportPathKind } from "./prototypeWebExport";

/** Exported pages live under the AutoMobile data directory by default, outliving temp cleanup. */
export class NodePrototypeWebExportFiles implements PrototypeWebExportFiles {
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

  async write(filePath: string, bytes: Uint8Array, options: { exclusive: boolean }): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes, { flag: options.exclusive ? "wx" : "w", mode: 0o644 });
  }
}
