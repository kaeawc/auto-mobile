import { mkdir, writeFile, rename, rm, access } from "node:fs/promises";
import { logger } from "../../utils/logger";
import type { SavedPrototypeLayoutFileSystem } from "./savedPrototypeLayout";

export class NodeSavedPrototypeLayoutFileSystem implements SavedPrototypeLayoutFileSystem {
  async ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    await writeFile(path, bytes);
  }
  async rename(from: string, to: string): Promise<void> {
    await rename(from, to);
  }
  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }
  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      logger.warn("Could not check saved prototype destination", error);
      throw error;
    }
  }
}
