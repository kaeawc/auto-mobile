import * as yaml from "js-yaml";
import { BootedDevice, Plan, PlanStep, type Platform } from "../models";
import { ActionableError, toActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { getMcpServerVersion, releaseVersion } from "../utils/mcpVersion";
import { PlanValidator } from "../utils/plan/PlanValidator";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { TouchTrackFailure } from "../features/record/android/types";
import { DualTrackRecorder } from "../features/record/android";
import { defaultDaemonContext } from "./daemonContext";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import { isOwnerWithinBase } from "../db/videoRecordingRepository";

/** Device gesture recordings observe on-device input; recordToolCalls records AutoMobile tool calls. */
export const DEVICE_GESTURE_RECORDING_CAPTURE_SCOPE = "user-input" as const;
export const NO_USER_INPUT_CAPTURED_REASON = "no_user_input_captured" as const;
export const DEVICE_GESTURE_RECORDING_USER_INPUT_ONLY_NOTICE: string =
  "Device gesture recordings capture input made on the device itself (touches on its touch screen or emulator window, and text changes in input fields). " +
  "Taps, swipes and other gestures sent through AutoMobile tools (tapAt, tapOn, swipeOn, etc.) or adb shell input are injected and are not recorded by design; use recordToolCalls to record tool calls.";

/** Plain empty capture, distinct from touch-track and recorder-stop failures. */
export class NoUserInputCapturedError extends ActionableError {
  readonly reason = NO_USER_INPUT_CAPTURED_REASON;

  /** `omitted` names input that was recorded but could not be exported, so it is not "nothing". */
  constructor(omitted?: string) {
    super(
      "No recorded interactions were captured. " +
        DEVICE_GESTURE_RECORDING_USER_INPUT_ONLY_NOTICE +
        (omitted ? ` ${omitted}` : ""),
    );
  }
}

interface DeviceGestureRecordingStartResult {
  recordingId: string;
  startedAt: string;
  deviceId: string;
  platform: Platform;
}

interface DeviceGestureRecordingStopResult {
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

export interface DeviceGestureRecordingStatus {
  recordingId: string;
  deviceId: string;
  platform: Platform;
  startedAt: string;
  eventCount: number;
  durationMs: number;
  /** On-device user-input capture; tool calls belong to recordToolCalls. */
  captureScope: typeof DEVICE_GESTURE_RECORDING_CAPTURE_SCOPE;
  /** Explains an empty capture; omitted once at least one step exists. */
  notice?: string;
}

interface RecordingSession {
  recordingId: string;
  deviceId: string;
  platform: Platform;
  startedAt: number;
  /** Keep release-time and socket stops on the same injected clock as the start. */
  timer: Timer;
  recorder: TestRecorder;
  /** Daemon session that started the recording; undefined for an unowned (direct) start. */
  ownerSessionUuid?: string;
}

const STOP_RECORDING_TIMEOUT_MS = 10_000;

type TestRecorder = Pick<DualTrackRecorder, "start" | "stop" | "stepCount"> &
  /** Steps captured so far; lets a stop that failed or timed out still return them. */
  Partial<Pick<DualTrackRecorder, "capturedSteps" | "capturedExportWarnings">>;
type RecorderFactory = (device: BootedDevice) => TestRecorder;

let activeRecording: RecordingSession | null = null;
let startingRecording: {
  session: RecordingSession;
  promise: Promise<DeviceGestureRecordingStartResult>;
} | null = null;
let stoppingRecording: {
  session: RecordingSession;
  promise: Promise<DeviceGestureRecordingStopResult>;
} | null = null;

const MAX_RETAINED_STOPPED_PLANS = 16;

/**
 * Finalized plans of owned recordings by recording id (#10958), so a plan produced by a
 * release-time stop is not lost: the previous owner fetches it with the id. Bounded, oldest
 * dropped first.
 */
const stoppedPlans = new Map<string, { owner: string; result: DeviceGestureRecordingStopResult }>();

function retainStoppedPlan(
  session: RecordingSession,
  result: DeviceGestureRecordingStopResult,
): void {
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

/** Base session of a derived `${base}:${label}` session; itself when the daemon is not up. */
function daemonBaseSessionUuid(sessionUuid: string): string {
  const sessionManager = defaultDaemonContext.sessionManager();
  if (!sessionManager) {
    return sessionUuid;
  }
  return resolveToolSelectionBaseSessionUuid(sessionUuid, sessionManager) ?? sessionUuid;
}

/**
 * The retained plan of a stopped recording, for the session that owned it and, as for an active
 * recording (#11140), its base session or a sibling derived session of the same base (#11533).
 * `baseSessionUuid` resolves a session to its base; another base's plans stay hidden.
 */
export function getStoppedDeviceGestureRecording(
  recordingId: string,
  ownerSessionUuid: string | undefined,
  baseSessionUuid: (sessionUuid: string) => string = daemonBaseSessionUuid,
): DeviceGestureRecordingStopResult | undefined {
  const entry = stoppedPlans.get(recordingId);
  if (!entry || ownerSessionUuid === undefined) {
    return undefined;
  }
  return deviceGestureRecordingOwnerVisible(entry.owner, ownerSessionUuid, baseSessionUuid)
    ? entry.result
    : undefined;
}

function deviceGestureRecordingOwnerVisible(
  owner: string | undefined,
  requester: string | undefined,
  baseSessionUuid: (sessionUuid: string) => string,
): boolean {
  if (owner === undefined || requester === undefined) {
    return false;
  }
  const requesterBase = baseSessionUuid(requester);
  return (
    owner === requester ||
    isOwnerWithinBase(owner, requesterBase) ||
    baseSessionUuid(owner) === requesterBase
  );
}

/**
 * Join only the owner's announced id before live-session gates (#10958). The shared stop
 * already has STOP_RECORDING_TIMEOUT_MS as its deadline; no additional timer is needed.
 * A stranger or an unknown id returns immediately, without waiting on or exposing the stop.
 */
export async function joinInFlightDeviceGestureRecordingStop(
  recordingId: string,
  ownerSessionUuid: string | undefined,
  baseSessionUuid: (sessionUuid: string) => string = daemonBaseSessionUuid,
): Promise<DeviceGestureRecordingStopResult | undefined> {
  const stopping = stoppingRecording;
  if (
    !stopping ||
    stopping.session.recordingId !== recordingId ||
    !deviceGestureRecordingOwnerVisible(
      stopping.session.ownerSessionUuid,
      ownerSessionUuid,
      baseSessionUuid,
    )
  ) {
    return undefined;
  }
  await stopping.promise;
  return getStoppedDeviceGestureRecording(recordingId, ownerSessionUuid, baseSessionUuid);
}

/** Test seam: forget retained plans. */
export function resetStoppedDeviceGestureRecordings(): void {
  stoppedPlans.clear();
}

export function getDeviceGestureRecordingStatus(
  timer: Timer = defaultTimer,
): DeviceGestureRecordingStatus | null {
  if (!activeRecording) {
    return null;
  }

  const durationMs = timer.now() - activeRecording.startedAt;
  const eventCount = activeRecording.recorder.stepCount;

  return {
    recordingId: activeRecording.recordingId,
    deviceId: activeRecording.deviceId,
    platform: activeRecording.platform,
    startedAt: new Date(activeRecording.startedAt).toISOString(),
    eventCount,
    durationMs,
    captureScope: DEVICE_GESTURE_RECORDING_CAPTURE_SCOPE,
    ...(eventCount === 0 ? { notice: DEVICE_GESTURE_RECORDING_USER_INPUT_ONLY_NOTICE } : {}),
  };
}

/**
 * The recording whose capture may still be running: active, starting, or stopping (#11533). A
 * stop in flight keeps its owner until the recorder has torn down, so a release in that window
 * still registers its device cleanup and awaits the stop rather than returning the device to the
 * pool with capture running.
 */
function ownableSession(): RecordingSession | null {
  return activeRecording ?? startingRecording?.session ?? stoppingRecording?.session ?? null;
}

/** Adopt capture still running or starting, including teardown already in flight. */
export function adoptOwnerlessDeviceGestureRecording(
  deviceId: string,
  sessionUuid: string,
): boolean {
  const session = ownableSession();
  if (!session || session.deviceId !== deviceId || session.ownerSessionUuid !== undefined) {
    return false;
  }
  session.ownerSessionUuid = sessionUuid;
  return true;
}

/**
 * Whether the daemon session `sessionUuid` owns the live device gesture recording on `deviceId`;
 * `undefined` asks about an owner-less (sessionless) one.
 */
export function isDeviceGestureRecordingOwnedBy(
  sessionUuid: string | undefined,
  deviceId: string,
): boolean {
  const session = ownableSession();
  return (
    session !== null && session.ownerSessionUuid === sessionUuid && session.deviceId === deviceId
  );
}

/** Id of the live device gesture recording `isDeviceGestureRecordingOwnedBy` matches; its plan stays fetchable by that id. */
export function ownedDeviceGestureRecordingId(
  sessionUuid: string | undefined,
  deviceId: string,
): string | undefined {
  const session = ownableSession();
  return session && isDeviceGestureRecordingOwnedBy(sessionUuid, deviceId)
    ? session.recordingId
    : undefined;
}

const buildPlanFromSteps = (
  steps: PlanStep[],
  session: RecordingSession,
  planName: string,
  { stoppedAt, omittedInput }: { stoppedAt: number; omittedInput?: string },
): { plan: Plan; stepCount: number } => {
  if (steps.length === 0) {
    throw new NoUserInputCapturedError(omittedInput);
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

/** Which session owns a new recording, and how owner UUIDs fold onto their base session. */
export interface DeviceGestureRecordingOwnership {
  ownerSessionUuid?: string;
  baseSessionUuid?: (sessionUuid: string) => string;
}

/** Refuses joining a recording on another device or one another session owns. */
function assertRecordingJoinable(
  existing: Pick<RecordingSession, "deviceId" | "recordingId" | "ownerSessionUuid">,
  device: BootedDevice,
  { ownerSessionUuid, baseSessionUuid }: DeviceGestureRecordingOwnership,
): void {
  if (existing.deviceId !== device.deviceId) {
    throw new Error(
      `Recording already active on device ${existing.deviceId} (${existing.recordingId}). ` +
        `Stop the existing recording before starting a new one on ${device.deviceId}.`,
    );
  }
  const ownerMatches =
    existing.ownerSessionUuid === ownerSessionUuid ||
    deviceGestureRecordingOwnerVisible(
      existing.ownerSessionUuid,
      ownerSessionUuid,
      baseSessionUuid ?? daemonBaseSessionUuid,
    );
  if (!ownerMatches) {
    throw new ActionableError(
      `A recording owned by another session is active on device ${device.deviceId}. Wait for it to stop before starting a recording.`,
    );
  }
}

export async function startDeviceGestureRecording(
  device: BootedDevice,
  timer: Timer = defaultTimer,
  idGenerator: IdGenerator = defaultIdGenerator,
  recorderFactory: RecorderFactory = (target) => new DualTrackRecorder(target),
  ownership: DeviceGestureRecordingOwnership = {},
): Promise<DeviceGestureRecordingStartResult> {
  if (stoppingRecording) {
    await stoppingRecording.promise.catch(() => undefined);
    return startDeviceGestureRecording(device, timer, idGenerator, recorderFactory, ownership);
  }
  const { ownerSessionUuid } = ownership;

  if (activeRecording) {
    assertRecordingJoinable(activeRecording, device, ownership);
    logger.info(
      `[DeviceGestureRecording] Recording already active (${activeRecording.recordingId}), returning existing session`,
    );
    return {
      recordingId: activeRecording.recordingId,
      startedAt: new Date(activeRecording.startedAt).toISOString(),
      deviceId: activeRecording.deviceId,
      platform: activeRecording.platform,
    };
  }

  if (startingRecording) {
    assertRecordingJoinable(startingRecording.session, device, ownership);
    return startingRecording.promise;
  }

  if (device.platform !== "android") {
    throw new Error(
      `Device gesture recording is only supported on Android right now (got ${device.platform}).`,
    );
  }

  const recordingId = idGenerator.next();
  const startedAt = timer.now();

  const session: RecordingSession = {
    recordingId,
    deviceId: device.deviceId,
    platform: device.platform,
    startedAt,
    timer,
    recorder: recorderFactory(device),
    ownerSessionUuid,
  };
  const promise = Promise.resolve().then(async () => {
    try {
      await session.recorder.start();
      activeRecording = session;
      logger.info(
        `[DeviceGestureRecording] Started recording ${recordingId} on ${device.deviceId}`,
      );
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
          "Failed to start device gesture recording",
        );
      }
      throw toActionableError(error, "Failed to start device gesture recording");
    } finally {
      if (startingRecording?.session === session) {
        startingRecording = null;
      }
    }
  });
  startingRecording = { session, promise };
  return promise;
}

/** Stops without an explicit clock use the recorder's injected clock, including release cleanup. */
function deviceGestureRecordingStopTimer(): Timer {
  return ownableSession()?.timer ?? defaultTimer;
}

export async function stopDeviceGestureRecording(
  recordingId?: string,
  planName?: string,
  timer: Timer = deviceGestureRecordingStopTimer(),
  options: { hostOnly?: boolean } = {},
): Promise<DeviceGestureRecordingStopResult> {
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
  const promise = stopAndBuildResult(session, planName, timer, options)
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
  /** Recorded input left out of the plan because replay cannot reproduce it. */
  exportWarnings?: string[];
  /** Why the recorder's stop did not finish, when the captured steps were returned anyway. */
  salvagedAfter?: string;
}

/**
 * Stop the recorder under the stop deadline. The session is already released, so a
 * failed or timed-out stop must not also throw away what was captured: the recorder
 * collects its steps before it does any device work, so they are returned with a
 * warning whenever it can still hand them over.
 */
async function stopRecorder(
  session: RecordingSession,
  timer: Timer,
  options: { hostOnly?: boolean },
): Promise<RecorderStopOutcome> {
  try {
    return await raceWithDeadline(() => session.recorder.stop(options), {
      timer,
      timeoutMs: STOP_RECORDING_TIMEOUT_MS,
      label: "Stopping device gesture recording",
      timeoutError: () =>
        new Error(`Device gesture recording stop timed out after ${STOP_RECORDING_TIMEOUT_MS} ms`),
    });
  } catch (error) {
    logger.warn(`[DeviceGestureRecording] Failed to stop recording ${session.recordingId}`, error);
    const captured = session.recorder.capturedSteps ?? [];
    if (captured.length === 0) {
      throw toActionableError(error, "Failed to stop device gesture recording");
    }
    return {
      steps: [...captured],
      exportWarnings: [...(session.recorder.capturedExportWarnings ?? [])],
      salvagedAfter: errorMessage(error),
    };
  }
}

/** The warning for recorded input the plan could not represent, logged when there is one. */
function describeExportWarnings(exportWarnings: string[] | undefined): string | undefined {
  if (!exportWarnings?.length) {
    return undefined;
  }
  const message = `Some recorded input was left out of the plan: ${exportWarnings.join("; ")}.`;
  logger.warn(`[DeviceGestureRecording] ${message}`);
  return message;
}

async function stopAndBuildResult(
  session: RecordingSession,
  planName: string | undefined,
  timer: Timer,
  options: { hostOnly?: boolean },
): Promise<DeviceGestureRecordingStopResult> {
  const { steps, touchTrackFailure, geometryWarnings, exportWarnings, salvagedAfter } =
    await stopRecorder(session, timer, options);

  const touchTrackMessage = touchTrackFailure
    ? `Touch track (getevent) stopped ${touchTrackFailure.failedAt - session.startedAt} ms after recording start: ${touchTrackFailure.error.message}. Later taps may be missing.`
    : undefined;
  if (touchTrackMessage && steps.length === 0) {
    throw toActionableError(
      new Error(touchTrackMessage, { cause: touchTrackFailure?.error }),
      "Failed to stop device gesture recording",
    );
  }
  // Preserve useful partial plans, including accessibility-only inputText steps.
  // The export schema has no warnings field, so success carries its warning in error.
  if (touchTrackMessage) {
    logger.warn(`[DeviceGestureRecording] ${touchTrackMessage}`);
  }
  // A rotation or display size change (or an unreadable rotation) can leave tapAt/swipeOn
  // steps at the wrong coordinates or direction (#10174); never report that as a clean plan.
  const geometryMessage = geometryWarnings?.length
    ? `Display geometry changed or was unreadable during recording: ${geometryWarnings.join("; ")}. Steps labelled "Warning:" may be recorded at the wrong coordinates or direction.`
    : undefined;
  if (geometryMessage) {
    logger.warn(`[DeviceGestureRecording] ${geometryMessage}`);
  }
  const exportMessage = describeExportWarnings(exportWarnings);
  const salvageMessage = salvagedAfter
    ? `Stopping the recorder did not finish (${salvagedAfter}); the steps captured so far are returned without confirming display rotation/size, so tapAt and swipeOn steps recorded after a display change may be at the wrong coordinates or direction.`
    : undefined;
  if (salvageMessage) {
    logger.warn(`[DeviceGestureRecording] ${salvageMessage}`);
  }
  const warningMessage = [touchTrackMessage, geometryMessage, exportMessage, salvageMessage]
    .filter(Boolean)
    .join(" ");

  const stoppedAt = timer.now();
  const resolvedPlanName = formatPlanName(planName);
  const { plan, stepCount } = buildPlanFromSteps(steps, session, resolvedPlanName, {
    stoppedAt,
    omittedInput: exportMessage,
  });
  const planContent = yaml.dump(plan, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
  });

  const durationMs = stoppedAt - session.startedAt;

  logger.info(
    `[DeviceGestureRecording] Stopped recording ${session.recordingId} with ${stepCount} steps`,
  );

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
