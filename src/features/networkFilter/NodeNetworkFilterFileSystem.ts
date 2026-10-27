import * as fs from "node:fs/promises";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { NetworkFilterFileSystem } from "./networkFilterHost";

export const SECURE_DIR_MODE = 0o700;

export const SECURE_FILE_MODE = 0o600;

export async function statKind(path: string): Promise<"file" | "directory" | null> {
  try {
    const stats = await fs.stat(path);
    if (stats.isDirectory()) {
      return "directory";
    }
    return stats.isFile() ? "file" : null;
  } catch (error) {
    // A missing path is the expected "not installed / not cached" answer.
    logger.debug(`[NETWORK_FILTER] ${path} is not statable: ${errorMessage(error)}`);
    return null;
  }
}

export class NodeNetworkFilterFileSystem implements NetworkFilterFileSystem {
  async isDirectory(path: string): Promise<boolean> {
    return (await statKind(path)) === "directory";
  }

  async isFile(path: string): Promise<boolean> {
    return (await statKind(path)) === "file";
  }

  async readText(path: string): Promise<string | null> {
    try {
      return await fs.readFile(path, "utf8");
    } catch (error) {
      // Missing metadata/receipts are expected before the first download or install.
      logger.debug(`[NETWORK_FILTER] ${path} is not readable: ${errorMessage(error)}`);
      return null;
    }
  }

  async writeText(path: string, content: string): Promise<void> {
    await fs.writeFile(path, content, { encoding: "utf8", mode: SECURE_FILE_MODE });
  }

  async ensureDir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true, mode: SECURE_DIR_MODE });
  }

  async remove(path: string): Promise<void> {
    await fs.rm(path, { recursive: true, force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
  }
}
