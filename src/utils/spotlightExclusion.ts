import { join } from "node:path";
import { logger } from "./logger";

export interface SpotlightFileSystem {
  writeFile(path: string, data: string): Promise<void>;
}

/** Best-effort marker for long-lived generated roots; filesystem access is injected. */
export async function markSpotlightExcluded(
  dir: string,
  fsLike: SpotlightFileSystem,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "darwin") return;
  try {
    await fsLike.writeFile(join(dir, ".metadata_never_index"), "");
  } catch (error) {
    // A missing optional Spotlight marker does not affect cache correctness.
    logger.debug(`Could not mark Spotlight exclusion for ${dir}: ${error}`);
  }
}
