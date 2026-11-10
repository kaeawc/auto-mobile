import * as fs from "node:fs/promises";
import type { ObserveResult } from "../../../models/ObserveResult";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { ScreenshotEvidenceFiles } from "./observationScreenshotEvidence";
import { getScreenshotStateStore, type ScreenshotStateStore } from "./ScreenshotStateRegistry";

/**
 * An async capture commits its path to the store, not to the observation. Stamp the
 * committed file's capture time so the response can report how far the screenshot
 * trails the hierarchy (#17765), without advertising the path itself.
 */
export async function stampAsyncScreenshotCapturedAt(
  observation: ObserveResult,
  deviceId: string,
  {
    files = fs,
    store = getScreenshotStateStore(),
  }: { files?: ScreenshotEvidenceFiles; store?: ScreenshotStateStore } = {},
): Promise<void> {
  const path = observation.observationId
    ? store.getPathForObservation(deviceId, observation.observationId)
    : undefined;
  if (!path) {
    return;
  }
  try {
    const { mtimeMs } = await files.stat(path);
    if (Number.isFinite(mtimeMs)) {
      observation.screenshotCapturedAt = new Date(mtimeMs).toISOString();
    }
  } catch (error) {
    // Capture timing is diagnostic; a swept file only leaves the lag unreported.
    logger.debug(`[OBSERVE] screenshot capture time unavailable: ${errorMessage(error)}`);
  }
}
