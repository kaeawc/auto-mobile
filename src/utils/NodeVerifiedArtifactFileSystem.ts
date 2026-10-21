import * as fs from "node:fs/promises";
import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
import type { VerifiedArtifactFileSystem } from "./VerifiedArtifactCache";

export class NodeVerifiedArtifactFileSystem implements VerifiedArtifactFileSystem {
  async readText(path: string): Promise<string | null> {
    try {
      return await fs.readFile(path, "utf8");
    } catch (error) {
      // Missing metadata is the normal cold-cache case.
      logger.debug(`Unreadable cache file ${path}: ${errorMessage(error)}`);
      return null;
    }
  }

  async writeText(path: string, content: string, mode?: number): Promise<void> {
    await fs.writeFile(path, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  }

  async remove(path: string): Promise<void> {
    await fs.rm(path, { force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
  }
}
