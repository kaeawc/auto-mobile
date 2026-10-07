import { ActionableError } from "../../models/ActionableError";
import {
  deviceLostErrorFromAbortSignal,
  rememberDeviceLossAbort,
} from "../../models/DeviceLostError";
import type { Plan } from "../../models/Plan";
import { logger } from "../logger";
import { findArrivalsBlockedByFailedTrack, type BlockedArrival } from "./BarrierResumeGuard";

/** The plan step a participant track terminally failed at. */
export interface FailedParticipantStep {
  stepIndex: number;
  tool: string;
  error: string;
}

/**
 * A barrier/criticalSection arrival that cannot be satisfied because a
 * participant track already failed (issue #10025). It is a consequence of that
 * track's failure, never a root cause.
 */
export class ParticipantFailedError extends ActionableError {
  readonly track: string;
  readonly failedStepIndex: number;

  constructor(arrival: BlockedArrival, track: string, failed: FailedParticipantStep) {
    const kind = arrival.tool === "barrier" ? "Barrier" : "Critical section";
    super(
      `${kind} "${arrival.lock}" can no longer be satisfied: participant track "${track}" ` +
        `failed at step ${failed.stepIndex} (${failed.tool}): ${failed.error}`,
    );
    this.name = "ParticipantFailedError";
    this.track = track;
    this.failedStepIndex = failed.stepIndex;
  }
}

/**
 * Tells surviving device tracks that a participant track has failed, so a
 * barrier they are waiting at (or later reach) fails promptly instead of
 * waiting out its timeout.
 *
 * Under `abortStrategy: "finish-current-step"` an ordinary failure on one track
 * lets the others run on. Without this, a survivor whose next coordination step
 * is shared with the failed track would block for the full barrier timeout and
 * report that timeout as the plan's failure (issue #10025). Only arrivals in a
 * generation the failed track will never join are affected; siblings that never
 * needed the failed track, and participants that are merely slow, are untouched.
 */
export class ParticipantFailureTracker {
  /** track -> plan index of one of its arrivals -> why it can no longer be satisfied. */
  private readonly blocked = new Map<string, Map<number, ParticipantFailedError>>();
  /** track -> the step it is executing now and the controller that can interrupt it. */
  private readonly running = new Map<string, { planIndex: number; controller: AbortController }>();
  /** track -> the blocked arrival whose wait was cut short while it was parked there. */
  private readonly interrupted = new Map<string, number>();

  constructor(private readonly plan: Plan) {}

  /**
   * Record that the track is about to run the step at `planIndex`. Returns the
   * participant failure when that step is an arrival that can no longer be
   * satisfied (the caller must not run it), otherwise the step's signal: the
   * plan-wide `parent` plus a per-step interrupt for a wait that becomes
   * unsatisfiable while the step is parked at its barrier.
   */
  beginStep(
    track: string,
    planIndex: number,
    parent: AbortSignal | undefined,
  ): { failure: ParticipantFailedError } | { signal: AbortSignal } {
    const failure = this.blocked.get(track)?.get(planIndex);
    if (failure) {
      return { failure };
    }
    const controller = new AbortController();
    this.running.set(track, { planIndex, controller });
    if (!parent) {
      return { signal: controller.signal };
    }
    const signal = AbortSignal.any([parent, controller.signal]);
    // A derived signal is not the one the plan registered device loss against, and some
    // runtimes hide the typed reason, so carry it over before any waiter reads the signal.
    signal.addEventListener(
      "abort",
      () => {
        const loss = deviceLostErrorFromAbortSignal(parent);
        if (loss) {
          rememberDeviceLossAbort(signal, loss);
        }
      },
      { once: true },
    );
    return { signal };
  }

  endStep(track: string): void {
    this.running.delete(track);
  }

  /** The failure that cut the track's wait short at `planIndex`, if any. */
  interruptionAt(track: string, planIndex: number): ParticipantFailedError | undefined {
    return this.interrupted.get(track) === planIndex
      ? this.blocked.get(track)?.get(planIndex)
      : undefined;
  }

  /**
   * A track ended in failure. Block every arrival of the other tracks that
   * shares a generation with one of its never-to-happen arrivals, interrupting
   * any that is already waiting.
   */
  trackFailed(track: string, failed: FailedParticipantStep): void {
    for (const arrival of findArrivalsBlockedByFailedTrack(this.plan, track, failed.stepIndex)) {
      this.block(arrival, new ParticipantFailedError(arrival, track, failed));
    }
  }

  private block(arrival: BlockedArrival, candidate: ParticipantFailedError): void {
    const perTrack = this.blocked.get(arrival.device) ?? new Map<number, ParticipantFailedError>();
    this.blocked.set(arrival.device, perTrack);
    // The first failure is the root cause; later ones only repeat the symptom.
    const error = perTrack.get(arrival.planIndex) ?? candidate;
    perTrack.set(arrival.planIndex, error);
    const running = this.running.get(arrival.device);
    if (running?.planIndex === arrival.planIndex) {
      logger.info(
        `[PARALLEL_EXEC][${arrival.device}] Releasing wait at "${arrival.lock}": ${error.message}`,
      );
      this.interrupted.set(arrival.device, arrival.planIndex);
      running.controller.abort(error);
    }
  }
}

/** True when the abort `signal` was raised because a participant track failed. */
export function isParticipantFailureAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason instanceof ParticipantFailedError;
}
