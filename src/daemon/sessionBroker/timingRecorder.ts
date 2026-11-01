import type {
  SessionBrokerAcquisitionTiming,
  SessionBrokerResetTiming,
} from "../../devices/sessionBrokerResult";
import { errorMessage } from "../../utils/describeUnknownError";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import type { ResetResult, SessionPreparationTiming } from "./devicePort";
import { ResetFailureError } from "./ResetFailureError";
import { nativeProfile } from "./profile";
import type { SqliteSessionBrokerStore } from "./sqliteStore";
import type {
  BrokerAdmission,
  BrokerRequestRecord,
  BrokerResourceRecord,
  BrokerAdmissionInput,
} from "./store";

/** The admission decision a pending acquisition timing records. */
export interface PendingAdmissionTiming {
  kind: "create" | "reuse" | "evict" | "wait";
  now: number;
  creationProfile?: unknown;
}

function continuedAcquisitionTiming(
  previous: SessionBrokerAcquisitionTiming,
  request: BrokerRequestRecord,
  resource: BrokerResourceRecord,
  { kind, now, creationProfile }: PendingAdmissionTiming,
) {
  if (
    kind === "wait" ||
    (previous.admission !== "wait" &&
      previous.admission !== "reuse" &&
      (kind !== "reuse" || previous.admission !== "evict-then-create"))
  ) {
    return {};
  }
  const acquisition: SessionBrokerAcquisitionTiming = {
    ...previous,
    admission: kind === "evict" ? "evict-then-create" : kind,
    reuseCount: kind === "reuse" ? (resource.reuseCount ?? 0) : 0,
    admissionWaitMs: now - previous.startedAtMs,
    totalMs: now - previous.startedAtMs,
    ...(kind === "reuse" ? { createMs: 0, bootMs: 0 } : {}),
  };
  return {
    timing_json: JSON.stringify({ ...request.timing, acquisition }),
    timing_profile_json: JSON.stringify(
      nativeProfile(kind === "evict" ? { profile: creationProfile } : resource),
    ),
    timing_updated_at_ms: now,
  };
}

export function pendingAcquisitionTiming(
  input: BrokerAdmissionInput,
  request: BrokerRequestRecord,
  resource: BrokerResourceRecord,
  admission: PendingAdmissionTiming,
) {
  const { kind, now, creationProfile } = admission;
  if (input.timingStartedAtMs === undefined) {
    return {};
  }
  const previous = request.timing?.acquisition;
  if (previous) {
    return continuedAcquisitionTiming(previous, request, resource, admission);
  }
  const acquisition: SessionBrokerAcquisitionTiming = {
    admission: kind === "evict" ? "evict-then-create" : kind,
    reuseCount: kind === "reuse" ? (resource.reuseCount ?? 0) : 0,
    outcome: "pending",
    startedAtMs: input.timingStartedAtMs,
    queueMs: 0,
    admissionWaitMs: now - input.timingStartedAtMs,
    totalMs: now - input.timingStartedAtMs,
    ...(kind === "reuse" ? { createMs: 0, bootMs: 0 } : {}),
  };
  return {
    timing_json: JSON.stringify({ acquisition }),
    timing_profile_json: JSON.stringify(
      nativeProfile(kind === "evict" ? { profile: creationProfile } : resource),
    ),
    timing_updated_at_ms: now,
  };
}

export function completedAcquisitionTiming(
  request: BrokerRequestRecord,
  resource: BrokerResourceRecord,
  phases: SessionPreparationTiming | undefined,
  now: number,
) {
  const previous = request.timing?.acquisition;
  if (!previous) {
    return {};
  }
  const acquisition: SessionBrokerAcquisitionTiming = {
    ...previous,
    ...phases,
    ...(previous.admission === "reuse" ? { createMs: 0, bootMs: 0 } : {}),
    reuseCount: resource.reuseCount ?? 0,
    outcome: "ready",
    completedAtMs: now,
    totalMs: now - previous.startedAtMs,
  };
  return {
    timing_json: JSON.stringify({ ...request.timing, acquisition }),
    timing_profile_json: JSON.stringify(nativeProfile(resource)),
    timing_updated_at_ms: now,
  };
}

export class BrokerTimingRecorder {
  constructor(
    private readonly store: Pick<SqliteSessionBrokerStore, "recordTiming" | "getResource">,
    private readonly timer: Pick<Timer, "now">,
  ) {}

  async recordFailedAcquisition(request: BrokerRequestRecord): Promise<boolean> {
    try {
      const previous = request.timing?.acquisition;
      if (!previous || previous.outcome !== "pending") {
        return true;
      }
      const acquisition: SessionBrokerAcquisitionTiming = {
        ...previous,
        outcome: "failed",
        completedAtMs: this.timer.now(),
        totalMs: this.timer.now() - previous.startedAtMs,
      };
      await this.store.recordTiming(request.requestId, { acquisition });
      request.timing = { ...request.timing, acquisition };
      logger.info(
        `[SessionBroker] acquisition ${JSON.stringify({ requestId: request.requestId, profile: request.timingProfile, ...acquisition })}`,
      );
      return true;
    } catch (error) {
      logger.warn(`Could not record failed acquisition ${request.requestId}`, error);
      return false;
    }
  }

  async recordRefusedAdmission(admission: BrokerAdmission): Promise<void> {
    if (admission.kind === "refused") {
      await this.recordFailedAcquisition(admission.request);
    }
  }

  logReadyAcquisition(request: BrokerRequestRecord, resource: BrokerResourceRecord): void {
    const acquisition = request.timing?.acquisition;
    if (!acquisition) {
      return;
    }
    logger.info(
      `[SessionBroker] acquisition ${JSON.stringify({ requestId: request.requestId, profile: nativeProfile(resource), ...acquisition })}`,
    );
  }

  initialResetTiming(
    _request: BrokerRequestRecord,
    resource: BrokerResourceRecord,
  ): SessionBrokerResetTiming {
    return {
      mode: "none",
      outcome: "pending",
      phases: {},
      reuseCount: resource.reuseCount ?? 0,
      startedAtMs: this.timer.now(),
      totalMs: 0,
    };
  }

  async recordResetTiming(
    request: BrokerRequestRecord,
    resource: BrokerResourceRecord,
    timing: SessionBrokerResetTiming,
  ): Promise<boolean> {
    try {
      const current = await this.store.getResource(resource.resourceId);
      if (current?.state === "destroyed") {
        timing = destroyedResetTiming(timing, this.timer.now());
      }
      timing.totalMs = this.timer.now() - timing.startedAtMs;
      if (timing.outcome !== "pending") {
        timing.completedAtMs = this.timer.now();
      }
      await this.store.recordTiming(request.requestId, { reset: timing }, nativeProfile(resource));
      logger.info(
        `[SessionBroker] reset ${JSON.stringify({ requestId: request.requestId, profile: nativeProfile(resource), ...timing })}`,
      );
      return true;
    } catch (error) {
      logger.warn(`Could not record reset timing ${request.requestId}`, error);
      return false;
    }
  }

  mergeResetTiming(timing: SessionBrokerResetTiming, reset: ResetResult): SessionBrokerResetTiming {
    return typeof reset === "object"
      ? { ...timing, ...reset, phases: { ...timing.phases, ...reset.phases } }
      : { ...timing, outcome: reset };
  }

  failedResetTiming(timing: SessionBrokerResetTiming, error: unknown): SessionBrokerResetTiming {
    const failed =
      error instanceof ResetFailureError ? this.mergeResetTiming(timing, error.reset) : timing;
    return { ...failed, outcome: "pending", fallbackReason: errorMessage(error) };
  }
}

export function destroyedResetTiming(
  timing: SessionBrokerResetTiming,
  now: number,
): SessionBrokerResetTiming {
  return {
    ...timing,
    outcome: "destroyed",
    retired: true,
    completedAtMs: now,
    totalMs: now - timing.startedAtMs,
  };
}
