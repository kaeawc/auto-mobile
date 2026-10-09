import * as yaml from "js-yaml";
import { BootedDevice, Plan, PlanStep, type Platform } from "../models";
import { toActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { getMcpServerVersion, releaseVersion } from "../utils/mcpVersion";
import { PlanValidator } from "../utils/plan/PlanValidator";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { TouchTrackFailure } from "../features/record/android/types";
import { DualTrackRecorder } from "../features/record/android";

interface TestRecordingStartResult {
  recordingId: string;
  startedAt: string;
  deviceId: string;
  platform: Platform;
}

interface TestRecordingStopResult {
  /** Partial-plan warning, carried through the existing tool/socket error field. */
  error?: string;
  recordingId: string;
  startedAt: string;
  stoppedAt: string;
  durationMs: number;
  planName: string;
  planContent: string;
  stepCount: number;
  deviceId: string;
  platform: Platform;
}

export interface TestRecordingStatus {
  recordingId: string;
  deviceId: string;
  platform: Platform;
  startedAt: string;
  eventCount: number;
  durationMs: number;
}

interface RecordingSession {
  recordingId: string;
  deviceId: string;
  platform: Platform;
  startedAt: number;
  recorder: TestRecorder;
  /** Daemon session that started the recording; undefined for an unowned (direct) start. */
  ownerSessionUuid?: string;
}

const STOP_RECORDING_TIMEOUT_MS = 10_000;

type TestRecorder = Pick<DualTrackRecorder, "start" | "stop" | "stepCount"> &
  /** Steps captured so far; lets a stop that failed or timed out still return them. */
  Partial<Pick<DualTrackRecorder, "capturedSteps">>;
type RecorderFactory = (device: BootedDevice) => TestRecorder;

let activeRecording: RecordingSession | null = null;
let startingRecording: {
  session: RecordingSession;
  promise: Promise<TestRecordingStartResult>;
} | null = null;
let stoppingRecording: {
  session: RecordingSession;
  promise: Promise<TestRecordingStopResult>;
} | null = null;

const MAX_RETAINED_STOPPED_PLANS = 16;

/**
 * Finalized plans of owned recordings by recording id (#10958), so a plan produced by a
 * release-time stop is not lost: the previous owner fetches it with the id. Bounded, oldest
 * dropped first.
 */
const stoppedPlans = new Map<string, { owner: string; result: TestRecordingStopResult }>();

function retainStoppedPlan(session: RecordingSession, result: TestRecordingStopResult): void {
  if (!session.ownerSessionUuid) {
    return;
  }
  stoppedPlans.set(session.recordingId, { owner: session.ownerSessionUuid, result });
  if (stoppedPlans.size > MAX_RETAINED_STOPPED_PLANS) {
    const oldest = stoppedPlans.keys().next();
    if (!oldest.done) {
      stoppedPlans.delete(oldest.value);
    }
  }
}

/** The retained plan of a stopped recording, only for the session that owned it. */
export function getStoppedTestRecording(
  recordingId: string,
  ownerSessionUuid: string | undefined,
): TestRecordingStopResult | undefined {
  const entry = stoppedPlans.get(recordingId);
  return entry && ownerSessionUuid !== undefined && entry.owner === ownerSessionUuid
    ? entry.result
    : undefined;
}

/** Test seam: forget retained plans. */
export function resetStoppedTestRecordings(): void {
  stoppedPlans.clear();
}

export function getTestRecordingStatus(timer: Timer = defaultTimer): TestRecordingStatus | null {
  if (!activeRecording) {
    return null;
  }

  const durationMs = timer.now() - activeRecording.startedAt;

  return {
    recordingId: activeRecording.recordingId,
    deviceId: activeRecording.deviceId,
    platform: activeRecording.platform,
    startedAt: new Date(activeRecording.startedAt).toISOString(),
    eventCount: activeRecording.recorder.stepCount,
    durationMs,
  };
}

/** Whether the daemon session `sessionUuid` owns the live test recording on `deviceId`. */
export function isTestRecordingOwnedBy(sessionUuid: string, deviceId: string): boolean {
  const session = activeRecording ?? startingRecording?.session ?? null;
  return session?.ownerSessionUuid === sessionUuid && session.deviceId === deviceId;
}

const buildPlanFromSteps = (
  steps: PlanStep[],
  session: RecordingSession,
  planName: string,
  stoppedAt: number,
): { plan: Plan; stepCount: number } => {
  if (steps.length === 0) {
    throw new Error("No recorded interactions were captured.");
  }

  const startedAt = new Date(session.startedAt);
  const durationMs = stoppedAt - session.startedAt;

  const plan: Plan = {
    name: planName,
    description: `Recorded plan with ${steps.length} interaction(s).`,
    steps,
    // Release portion only — recorded plans are schema-validated (`^\d+\.\d+\.\d+$`)
    // before migration, so a dev build's `+g<sha>` stamp would make them unusable.
    mcpVersion: releaseVersion(getMcpServerVersion()),
    metadata: {
      createdAt: new Date(stoppedAt).toISOString(),
      version: "1.0.0",
      recording: {
        recordingId: session.recordingId,
        startedAt: startedAt.toISOString(),
        stoppedAt: new Date(stoppedAt).toISOString(),
        durationMs,
        deviceId: session.deviceId,
        platform: session.platform,
        interactionCount: steps.length,
      },
    },
  };

  PlanValidator.validate(plan);

  return { plan, stepCount: steps.length };
};

const formatPlanName = (planName?: string): string => {
  if (planName && planName.trim().length > 0) {
    return planName.trim();
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `recorded-plan-${timestamp}`;
};

export async function startTestRecording(
  device: BootedDevice,
  timer: Timer = defaultTimer,
  idGenerator: IdGenerator = defaultIdGenerator,
  recorderFactory: RecorderFactory = (target) => new DualTrackRecorder(target),
  ownerSessionUuid?: string,
): Promise<TestRecordingStartResult> {
  if (stoppingRecording) {
    await stoppingRecording.promise.catch(() => undefined);
    return startTestRecording(device, timer, idGenerator, recorderFactory, ownerSessionUuid);
  }

  if (activeRecording) {
    if (activeRecording.deviceId !== device.deviceId) {
      throw new Error(
        `Recording already active on device ${activeRecording.deviceId} (${activeRecording.recordingId}). ` +
          `Stop the existing recording before starting a new one on ${device.deviceId}.`,
      );
    }
    logger.info(
      `[TestRecording] Recording already active (${activeRecording.recordingId}), returning existing session`,
    );
    return {
      recordingId: activeRecording.recordingId,
      startedAt: new Date(activeRecording.startedAt).toISOString(),
      deviceId: activeRecording.deviceId,
      platform: activeRecording.platform,
    };
  }

  if (startingRecording) {
    const { session, promise } = startingRecording;
    if (session.deviceId !== device.deviceId) {
      throw new Error(
        `Recording already active on device ${session.deviceId} (${session.recordingId}). ` +
          `Stop the existing recording before starting a new one on ${device.deviceId}.`,
      );
    }
    return promise;
  }

  if (device.platform !== "android") {
    throw new Error(
      `Test recording is only supported on Android right now (got ${device.platform}).`,
    );
  }

  const recordingId = idGenerator.next();
  const startedAt = timer.now();

  const session: RecordingSession = {
    recordingId,
    deviceId: device.deviceId,
    platform: device.platform,
    startedAt,
    recorder: recorderFactory(device),
    ownerSessionUuid,
  };
  const promise = Promise.resolve().then(async () => {
    try {
      await session.recorder.start();
      activeRecording = session;
      logger.info(`[TestRecording] Started recording ${recordingId} on ${device.deviceId}`);
      return {
        recordingId,
        startedAt: new Date(startedAt).toISOString(),
        deviceId: device.deviceId,
        platform: device.platform,
      };
    } catch (error) {
      try {
        await session.recorder.stop();
      } catch (cleanupError) {
        throw toActionableError(
          new AggregateError([error, cleanupError], "Recorder startup and teardown both failed"),
          "Failed to start test recording",
        );
      }
      throw toActionableError(error, "Failed to start test recording");
    } finally {
      if (startingRecording?.session === session) {
        startingRecording = null;
      }
    }
  });
  startingRecording = { session, promise };
  return promise;
}

export async function stopTestRecording(
  recordingId?: string,
  planName?: string,
  timer: Timer = defaultTimer,
): Promise<TestRecordingStopResult> {
  if (startingRecording) {
    await startingRecording.promise;
  }
  const session = activeRecording ?? stoppingRecording?.session ?? null;
  if (!session) {
    throw new Error("No active recording. Start a recording before stopping.");
  }

  if (recordingId && recordingId !== session.recordingId) {
    throw new Error(
      `Recording ID ${recordingId} does not match active recording ${session.recordingId}.`,
    );
  }

  if (stoppingRecording?.session === session) {
    return stoppingRecording.promise;
  }

  activeRecording = null;
  const promise = stopAndBuildResult(session, planName, timer)
    .then((result) => {
      retainStoppedPlan(session, result);
      return result;
    })
    .finally(() => {
      if (stoppingRecording?.session === session) {
        stoppingRecording = null;
      }
    });
  stoppingRecording = { session, promise };
  return promise;
}

interface RecorderStopOutcome {
  steps: PlanStep[];
  touchTrackFailure?: TouchTrackFailure;
  geometryWarnings?: string[];
  /** Why the recorder's stop did not finish, when the captured steps were returned anyway. */
  salvagedAfter?: string;
}

/**
 * Stop the recorder under the stop deadline. The session is already released, so a
 * failed or timed-out stop must not also throw away what was captured: the recorder
 * collects its steps before it does any device work, so they are returned with a
 * warning whenever it can still hand them over.
 */
async function stopRecorder(session: RecordingSession, timer: Timer): Promise<RecorderStopOutcome> {
  try {
    return await raceWithDeadline(() => session.recorder.stop(), {
      timer,
      timeoutMs: STOP_RECORDING_TIMEOUT_MS,
      label: "Stopping test recording",
      timeoutError: () =>
        new Error(`Test recording stop timed out after ${STOP_RECORDING_TIMEOUT_MS} ms`),
    });
  } catch (error) {
    logger.warn(`[TestRecording] Failed to stop recording ${session.recordingId}`, error);
    const captured = session.recorder.capturedSteps ?? [];
    if (captured.length === 0) {
      throw toActionableError(error, "Failed to stop test recording");
    }
    return { steps: [...captured], salvagedAfter: errorMessage(error) };
  }
}

async function stopAndBuildResult(
  session: RecordingSession,
  planName: string | undefined,
  timer: Timer,
): Promise<TestRecordingStopResult> {
  const { steps, touchTrackFailure, geometryWarnings, salvagedAfter } = await stopRecorder(
    session,
    timer,
  );

  const touchTrackMessage = touchTrackFailure
    ? `Touch track (getevent) stopped ${touchTrackFailure.failedAt - session.startedAt} ms after recording start: ${touchTrackFailure.error.message}. Later taps may be missing.`
    : undefined;
  if (touchTrackMessage && steps.length === 0) {
    throw toActionableError(
      new Error(touchTrackMessage, { cause: touchTrackFailure?.error }),
      "Failed to stop test recording",
    );
  }
  // Preserve useful partial plans, including accessibility-only inputText steps.
  // The export schema has no warnings field, so success carries its warning in error.
  if (touchTrackMessage) {
    logger.warn(`[TestRecording] ${touchTrackMessage}`);
  }
  // A rotation or display size change (or an unreadable rotation) can leave tapAt/swipeOn
  // steps at the wrong coordinates or direction (#10174); never report that as a clean plan.
  const geometryMessage = geometryWarnings?.length
    ? `Display geometry changed or was unreadable during recording: ${geometryWarnings.join("; ")}. Steps labelled "Warning:" may be recorded at the wrong coordinates or direction.`
    : undefined;
  if (geometryMessage) {
    logger.warn(`[TestRecording] ${geometryMessage}`);
  }
  const salvageMessage = salvagedAfter
    ? `Stopping the recorder did not finish (${salvagedAfter}); the steps captured so far are returned without confirming display rotation/size, so tapAt and swipeOn steps recorded after a display change may be at the wrong coordinates or direction.`
    : undefined;
  if (salvageMessage) {
    logger.warn(`[TestRecording] ${salvageMessage}`);
  }
  const warningMessage = [touchTrackMessage, geometryMessage, salvageMessage]
    .filter(Boolean)
    .join(" ");

  const stoppedAt = timer.now();
  const resolvedPlanName = formatPlanName(planName);
  const { plan, stepCount } = buildPlanFromSteps(steps, session, resolvedPlanName, stoppedAt);
  const planContent = yaml.dump(plan, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
  });

  const durationMs = stoppedAt - session.startedAt;

  logger.info(`[TestRecording] Stopped recording ${session.recordingId} with ${stepCount} steps`);

  return {
    recordingId: session.recordingId,
    startedAt: new Date(session.startedAt).toISOString(),
    stoppedAt: new Date(stoppedAt).toISOString(),
    durationMs,
    planName: resolvedPlanName,
    planContent,
    stepCount,
    ...(warningMessage ? { error: `Warning: ${warningMessage}` } : {}),
    deviceId: session.deviceId,
    platform: session.platform,
  };
}
