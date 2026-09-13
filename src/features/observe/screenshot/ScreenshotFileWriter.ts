import { promises as fsPromises } from "node:fs";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";

/** Secure file mode: owner read/write only */
const SECURE_FILE_MODE = 0o600;

/**
 * Narrow seam for the capture files TakeScreenshot owns.
 *
 * Only the screenshot writer needs it, so it exposes exactly the two
 * operations that path performs: persisting a freshly captured frame, and
 * dropping one again when the request that produced it was cancelled. Tests
 * inject a fake to interleave a cancellation with the write.
 */
export interface ScreenshotFileWriter {
  /** Persist a capture. Fails if the path already exists. */
  write(filePath: string, data: Buffer): Promise<void>;
  /** Best-effort removal of a capture this writer created. */
  remove(filePath: string): Promise<void>;
}

/**
 * Writes atomically with secure permissions: the "wx" flag fails if the file
 * exists (prevents a TOCTOU race) and mode 0o600 keeps captures owner-only.
 */
export const defaultScreenshotFileWriter: ScreenshotFileWriter = {
  async write(filePath: string, data: Buffer): Promise<void> {
    const handle = await fsPromises.open(filePath, "wx", SECURE_FILE_MODE);
    try {
      await handle.write(data);
    } finally {
      await handle.close();
    }
  },

  async remove(filePath: string): Promise<void> {
    try {
      await fsPromises.unlink(filePath);
    } catch (error) {
      // The file may never have reached disk (a failed write, or a path this
      // process already cleaned up); either way there is nothing to recover.
      logger.debug(`[SCREENSHOT] Failed to remove capture ${filePath}: ${errorMessage(error)}`);
    }
  },
};
