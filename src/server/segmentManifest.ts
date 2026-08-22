import { errorMessage } from "../utils/describeUnknownError";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger";

/** File name of the per-session manifest written alongside the first segment. */
export const SEGMENT_MANIFEST_FILE = "segments.json";

/** One finalized segment of a segmented recording session, in capture order. */
export interface StoppedSegment {
  recordingId: string;
  filePath: string;
  segmentIndex: number;
}

/**
 * Write a `segments.json` manifest listing every segment of a session in order, so a caller
 * (or an external process that only sees the archive on disk) can discover and concatenate
 * the clips without re-deriving order. It is written into the FIRST segment's directory, so
 * the existing per-recording eviction (`rm(dirname)`) cleans it up with that segment — no new
 * eviction surface. Best-effort: a write failure is logged and returns undefined rather than
 * failing the stop, since the caller already holds the authoritative ordering.
 *
 * Shared by both the raw `videoRecording` stop path and the plan-driven finalize path
 * (`PlanExecutionOrchestrator`), which both produce ordered Android segment sets.
 */
export async function writeSegmentManifest(
  sessionId: string,
  segments: StoppedSegment[]
): Promise<string | undefined> {
  const first = segments[0];
  if (!first) {
    return undefined;
  }
  const manifestPath = path.join(path.dirname(first.filePath), SEGMENT_MANIFEST_FILE);
  try {
    const manifest = {
      sessionId,
      segmentCount: segments.length,
      segments: segments.map(segment => ({
        index: segment.segmentIndex,
        recordingId: segment.recordingId,
        filePath: segment.filePath,
      })),
    };
    await fsPromises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifestPath;
  } catch (error) {
    logger.warn(
      `[VideoRecording] Failed to write segment manifest for session ${sessionId}: ` +
      `${errorMessage(error)}`
    );
    return undefined;
  }
}
