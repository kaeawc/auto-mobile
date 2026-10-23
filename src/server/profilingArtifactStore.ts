import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ProfilingArtifactStore } from "../features/profiling/ProfilingArtifactStore";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { serverConfig } from "../utils/ServerConfig";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { getDefaultToolOutputsDir } from "../utils/toolOutputArtifacts";
import { safeFilenameSegment } from "./toolOutputArtifactLedger";

/**
 * Binary profiling artifacts land in the tool-outputs directory (`--tool-outputs-dir`, else the
 * default one), beside the JSON artifacts. The `automobile:tool-output` resource serves only the
 * JSON files its writer issued, so these are fetched by host path, never inlined.
 */
export function createToolOutputsProfilingStore(
  timer: Pick<Timer, "now"> = defaultTimer,
  directory: () => string = () => serverConfig.getToolOutputsDir() ?? getDefaultToolOutputsDir(),
): ProfilingArtifactStore {
  return {
    async allocatePath(kind, id, extension) {
      const dir = directory();
      await mkdir(dir, { recursive: true });
      return path.join(
        dir,
        `${Math.trunc(timer.now())}-${kind}-${safeFilenameSegment(id)}.${extension}`,
      );
    },
    async sizeOf(filePath) {
      try {
        return (await stat(filePath)).size;
      } catch (error) {
        // A missing file is the answer ("nothing was pulled"), not a failure.
        logger.debug(`[profiling] ${filePath} not readable: ${errorMessage(error)}`);
        return 0;
      }
    },
    async remove(filePath) {
      try {
        await rm(filePath, { force: true });
      } catch (error) {
        logger.warn(`[profiling] failed to remove ${filePath}: ${errorMessage(error)}`, error);
      }
    },
  };
}
