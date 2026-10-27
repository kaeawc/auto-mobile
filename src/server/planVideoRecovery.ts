import type { Timer } from "../utils/SystemTimer";
import type { VideoRecorder } from "./planExecutionRecords";
import { ActionableError, type VideoRecordingMetadata } from "../models";
import { runWithAbortSignal } from "../utils/AbortContext";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import {
  type CancelledVideoTeardown,
  DEFAULT_IOS_VIDEO_MAX_DURATION_SECONDS,
  type FinalizedVideo,
  IOS_VIDEO_PLAN_END_TOLERANCE_MS,
} from "./planExecutionRecords";
interface PlanVideoRecoveryContext {
  timer: Timer;
  videoRecorder: VideoRecorder;
}

/**
 * Runs a teardown under a private abort signal, not the cancelled request's, and
 * bounded by its cap. The cap cannot cancel work already started, so reaching it
 * aborts the private signal, which fails every further adb call that honors the
 * ambient signal (exec and spawn do); calls already past that check, and host-side
 * database work, still run to completion. A failure after the cap is logged here,
 * once, since the caller has stopped waiting.
 */
export async function runShieldedTeardown(
  context: Pick<PlanVideoRecoveryContext, "timer">,
  teardown: CancelledVideoTeardown,
): Promise<FinalizedVideo> {
  const shield = new AbortController();
  let capped = false;
  const observed = () =>
    teardown.run().catch((error: unknown) => {
      if (capped) {
        logger.warn(
          `${teardown.label} failed after its ${teardown.capMs}ms cap: ${errorMessage(error)}`,
          error,
        );
      }
      throw error;
    });
  return runWithAbortSignal(shield.signal, () =>
    raceWithDeadline(observed, {
      timer: context.timer,
      timeoutMs: teardown.capMs,
      label: teardown.label,
      onTimeout: () => {
        capped = true;
        shield.abort(new ActionableError(`${teardown.label} exceeded its ${teardown.capMs}ms cap`));
      },
    }),
  );
}

export async function recoverCompletedIosVideo(
  context: Pick<PlanVideoRecoveryContext, "videoRecorder">,
  recordingId: string,
  planEndMs: number,
): Promise<FinalizedVideo | undefined> {
  const { getVideoRecordingStatus, getVideoRecordingMetadata } = context.videoRecorder;
  if (!getVideoRecordingStatus || !getVideoRecordingMetadata) {
    return undefined;
  }
  try {
    if ((await getVideoRecordingStatus(recordingId)) !== "completed") {
      return undefined;
    }
    const metadata = await getVideoRecordingMetadata(recordingId, { touch: false });
    if (!metadata?.filePath) {
      return undefined;
    }
    if (!(metadata.sizeBytes > 0)) {
      logger.warn(
        `Cannot recover archived plan video ${recordingId}: completed metadata must prove host bytes exist`,
      );
      return undefined;
    }
    const videoWarnings = recoveredIosVideoWarnings(metadata, planEndMs);
    return {
      videoFilePaths: [metadata.filePath],
      videoRecordingIds: [recordingId],
      ...(videoWarnings.length ? { videoWarnings } : {}),
    };
  } catch (error) {
    logger.warn(`Failed to recover archived plan video ${recordingId}: ${errorMessage(error)}`);
    return undefined;
  }
}

export function recoveredIosVideoWarnings(
  metadata: VideoRecordingMetadata,
  planEndMs: number,
): string[] {
  const recordingId = metadata.recordingId;
  const endedWithPlan =
    Date.parse(metadata.endedAt ?? "") >= planEndMs - IOS_VIDEO_PLAN_END_TOLERANCE_MS;
  const warning =
    metadata.durationMs !== undefined &&
    metadata.durationMs >= DEFAULT_IOS_VIDEO_MAX_DURATION_SECONDS * 1000
      ? `Video recording ${recordingId} stopped at the ${DEFAULT_IOS_VIDEO_MAX_DURATION_SECONDS}s cap; the remainder of the plan was not recorded`
      : endedWithPlan
        ? undefined
        : `Video recording ${recordingId} ended before the plan finished; the remainder of the plan was not recorded`;
  const videoWarnings = [...new Set([...(metadata.warnings ?? []), ...(warning ? [warning] : [])])];
  return videoWarnings;
}
