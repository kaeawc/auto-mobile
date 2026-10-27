import { ObserveResult } from "../../models";
import { DispatchedObservationError } from "../../models/DispatchedObservationError";
import { sequenceBackoff } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import type {
  ObserveScreen,
  ObserveScreenExecuteOptions,
} from "../observe/interfaces/ObserveScreen";
import { isAdoptableCapture } from "../observe/isAdoptableCapture";
import { StaleDisplayError } from "../observe/StaleDisplayError";
import {
  FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS,
  FINAL_OBSERVATION_RETRY_BACKOFF_MS,
  PostActionCapture,
} from "./visualChangeDisplayFence";
export class PostActionObservationReader {
  constructor(private readonly timer: Timer) {}

  async capturePostActionObservation(
    observeScreen: ObserveScreen,
    options: ObserveScreenExecuteOptions,
    shouldRetry: (observation: ObserveResult) => boolean,
    blockResult: { success?: boolean; skipped?: unknown; wasAlreadyFocused?: boolean },
  ): Promise<PostActionCapture> {
    const perf = options.perf ?? new NoOpPerformanceTracker();
    const retryBackoff = sequenceBackoff(FINAL_OBSERVATION_RETRY_BACKOFF_MS);
    let latestObservation: ObserveResult | undefined;
    let trustworthyObservation: ObserveResult | undefined;
    const read = async () => {
      const observation = await observeScreen.execute(options);
      if (options.display !== undefined) {
        throwIfAborted(options.signal);
      }
      if (
        options.display !== undefined &&
        isAdoptableCapture(trustworthyObservation ?? observation, observation, true)
      ) {
        trustworthyObservation = observation;
      }
      return observation;
    };
    try {
      perf.serial("finalObserve");
      latestObservation = await read();
      perf.end();
      for (
        let attempt = 0;
        attempt < FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS && shouldRetry(latestObservation);
        attempt++
      ) {
        const delayMs = retryBackoff.delayForAttempt(attempt + 1);
        logger.info(
          `[BaseVisualChange] Observation appears stale/unchanged, retrying in ${delayMs}ms (attempt ${attempt + 1}/${FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS})`,
        );
        await this.timer.sleep(delayMs);
        perf.serial(`finalObserve_retry_${attempt + 1}`);
        latestObservation = await read();
        perf.end();
      }
    } catch (error) {
      return this.recoverPostActionObservation(
        error,
        trustworthyObservation ?? latestObservation,
        options,
        blockResult,
      );
    }
    return { observation: latestObservation, readFailed: false };
  }

  private recoverPostActionObservation(
    error: unknown,
    observation: ObserveResult | undefined,
    options: ObserveScreenExecuteOptions,
    blockResult: { success?: boolean; skipped?: unknown; wasAlreadyFocused?: boolean },
  ): PostActionCapture {
    if (options.display === undefined) {
      throw error;
    }
    throwIfAborted(options.signal);
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    if (observation && isAdoptableCapture(observation, observation, true)) {
      return this.notePostActionReadFailure(
        observation,
        "observation retry",
        errorMessage(error),
        error,
      );
    }
    // A refused or skipped block never delivered a gesture.
    if (blockResult.success === false || blockResult.skipped || blockResult.wasAlreadyFocused) {
      throw error;
    }
    throw new DispatchedObservationError(error);
  }

  notePostActionReadFailure(
    observation: ObserveResult,
    phase: string,
    reason: string,
    error?: unknown,
  ): PostActionCapture {
    const warning = `Post-action ${phase} failed: ${reason}; retaining the earlier observation`;
    logger.warn(`[BaseVisualChange] ${warning}`, error);
    return {
      observation: {
        ...observation,
        settled: false,
        freshness: {
          ...observation.freshness,
          isFresh: observation.freshness?.isFresh ?? true,
          warning: [observation.freshness?.warning, warning].filter(Boolean).join("; "),
        },
      },
      readFailed: true,
      ...(error instanceof StaleDisplayError ? { staleDisplay: error.details } : {}),
    };
  }
}
