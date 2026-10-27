import { ActionableError } from "../../models/ActionableError";
import { type BlockedArrival } from "./BarrierResumeGuard";
import type { FailedParticipantStep } from "./ParticipantFailureTracker";

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
