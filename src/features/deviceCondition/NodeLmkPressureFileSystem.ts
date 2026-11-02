import * as fs from "node:fs/promises";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { NodeVerifiedArtifactFileSystem } from "../../utils/NodeVerifiedArtifactFileSystem";
import type { VerifiedArtifactFileSystem } from "../../utils/VerifiedArtifactCache";

/** The cache files this provider reads and writes, beyond the shared cache workflow. */
export interface LmkPressureFileSystem extends VerifiedArtifactFileSystem {
  ensureDir(path: string): Promise<void>;
  /** Byte size, or null when the file is missing. */
  fileSize(path: string): Promise<number | null>;
}

export class NodeLmkPressureFileSystem
  extends NodeVerifiedArtifactFileSystem
  implements LmkPressureFileSystem
{
  async ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }

  async fileSize(file: string): Promise<number | null> {
    try {
      return (await fs.stat(file)).size;
    } catch (error) {
      // A missing cached binary is the normal cold-cache case.
      logger.debug(`[LMK_PRESSURE] No cached binary at ${file}: ${errorMessage(error)}`);
      return null;
    }
  }
}
