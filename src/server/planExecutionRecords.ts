import { DAEMON_SHUTTING_DOWN_ERROR_CODE } from "../daemon/wire/constants";
import { defaultDaemonContext, type PlanEndDaemonContext } from "../daemon/daemonContext";
import { idleReleaseField } from "../daemon/releaseReasons";
import { SESSION_OWNERSHIP_LOST_CODE } from "../daemon/sessionReleasedDuringCall";
import { isTypedToolRefusal, shapeToolCallError } from "../daemon/shapeToolCallError";
import { TestExecutionRepository, TestStepRecord } from "../db/testExecutionRepository";
import { BootedDevice, ExecutePlanResult, PlanExecutionResult, Platform } from "../models";
import {
  ExecutePlanStepDebugInfo,
  type PlanDeviceFailure,
  type PlanSkippedStep,
  type PlanStepToolResult,
  type PlanStepWarnings,
  type PlanToolResultsTruncation,
} from "../models/ExecutePlanResult";
import { ACQUIRE_NEW_SESSION_NEXT_ACTION } from "../models/deviceSessionRecovery";
import { typedRefusalFields } from "../models/typedRefusalFields";
import { Timer } from "../utils/SystemTimer";
import { isDeviceLostError } from "../utils/deviceLossOutcome";
import { normalizePlanDevices } from "../utils/plan/PlanDevices";
import { PlanSchemaValidator } from "../utils/plan/PlanSchemaValidator";
import {
  AndroidSegmentedPlanVideoSession,
  ROTATION_STOP_TIMEOUT_MS,
} from "./androidSegmentedPlanVideoSession";
import { type PlanHealthWriter } from "./filePlanHealthWriter";
import { type PlanDeviceOwnership } from "./planDeviceOwnership";
import { ProgressCallback } from "./toolRegistry";
import {
  getVideoRecordingMetadata as defaultGetVideoRecordingMetadata,
  getVideoRecordingStatus as defaultGetVideoRecordingStatus,
  rollbackVideoRecordingStart as defaultRollbackVideoRecordingStart,
  startVideoRecording as defaultStartVideoRecording,
  stopVideoRecording as defaultStopVideoRecording,
} from "../daemon/videoRecordingManager";

export type NormalizedPlanDevices = ReturnType<typeof normalizePlanDevices>;

/**
 * Test metadata captured per-execution for the test-execution timing repository.
 */
export interface PlanExecutionTestMetadata {
  testClass: string;
  testMethod: string;
  appVersion?: string;
  gitCommit?: string;
  targetSdk?: number;
  jdkVersion?: string;
  jvmTarget?: string;
  gradleVersion?: string;
  isCi?: boolean;
}

/**
 * All parameters accepted by the executePlan MCP tool — modeled as a value object
 * so the orchestrator's surface stays narrow and testable.
 */
export interface PlanExecutionRequest {
  planContent: string;
  startStep: number;
  platform: Platform;
  sessionUuid?: string;
  keepScreenAwake?: boolean;
  deviceId?: string;
  device?: string;
  devices?: string[];
  deviceAllocationTimeoutMs: number;
  abortStrategy?: "immediate" | "finish-current-step";
  testMetadata?: PlanExecutionTestMetadata;
  cleanupAppId?: string;
  cleanupClearAppData?: boolean;
  captureObserveSteps?: "summary" | "full";
}

/** Subset of videoRecordingManager APIs used by the orchestrator (so tests can inject fakes). */
export interface VideoRecorder {
  startVideoRecording: typeof defaultStartVideoRecording;
  stopVideoRecording: typeof defaultStopVideoRecording;
  getVideoRecordingStatus?: typeof defaultGetVideoRecordingStatus;
  getVideoRecordingMetadata?: typeof defaultGetVideoRecordingMetadata;
  /** Force-stops and discards a recording without pulling it; used when the plan was cancelled. */
  rollbackVideoRecordingStart?: typeof defaultRollbackVideoRecordingStart;
}

/**
 * Injectable dependencies for the orchestrator. Tests can swap any of these to
 * exercise individual phases without spinning up a daemon or device pool.
 *
 * Production callers should pass an empty object — sensible defaults are wired up.
 */
export interface PlanExecutionDependencies {
  /** Factory for the schema validator (lets tests skip schema loading). */
  createSchemaValidator?: () => Pick<PlanSchemaValidator, "loadSchema" | "validateYaml">;
  /** Repository used to record per-execution timing rows. */
  testExecutionRepository?: Pick<TestExecutionRepository, "recordExecution">;
  /** Clock + scheduled-task primitives, replaced by FakeTimer in tests. */
  timer?: Timer;
  /** Video recording manager surface — replaced by a fake in tests. */
  videoRecorder?: VideoRecorder;
  /** Whether the plan's session still holds its device at teardown — replaced by a fake in tests. */
  deviceOwnership?: PlanDeviceOwnership;
  /** Receives the end-of-run health summary; defaults to the AUTOMOBILE_PLAN_HEALTH_DIR writer. */
  healthWriter?: PlanHealthWriter;
}

export interface VideoState {
  warnings?: string[];
  androidSession?: AndroidSegmentedPlanVideoSession;
  /**
   * True when the Android session rotates segments from its own timer rather than from the
   * per-step hook. Multi-device plans run their tracks concurrently and never call the step
   * hook, so only the session's timer can rotate ahead of screenrecord's 180 s cap (#10026).
   */
  androidTimerDriven?: boolean;
  iosRecordingId?: string;
}

export interface FinalizedVideo {
  videoFilePaths: string[];
  videoRecordingIds: string[];
  videoWarnings?: string[];
}

export type ExecutionContext = {
  device: BootedDevice;
  request: PlanExecutionRequest;
  progress?: ProgressCallback;
  signal?: AbortSignal;
};

export const HEARTBEAT_INTERVAL_MS = 30_000;

export const DEFAULT_IOS_VIDEO_MAX_DURATION_SECONDS = 300;

// Allow small timestamp skew between backend completion and the orchestrator stop attempt.
export const IOS_VIDEO_PLAN_END_TOLERANCE_MS = 100;

/**
 * Bound on discarding a cancelled plan's recording after its session released the
 * device (#9885). The discard is a host process reap plus our own device temp file's
 * `rm -f` and row deletes, which takes well under a second when the device answers;
 * this caps a wedged device so a cancelled `executePlan` still returns promptly.
 */
export const CANCELLED_VIDEO_DISCARD_TIMEOUT_MS = 5_000;

/**
 * Overall bound on stopping and pulling the recording of a plan cancelled while its
 * session still owns the device (deadline, client cancel). It is the existing budget
 * for one whole segment stop-and-pull (rotation's `ROTATION_STOP_TIMEOUT_MS`, the
 * 10 s between screenrecord's 180 s cap and the 170 s rotation), applied once to the
 * whole teardown rather than per segment.
 */
export const CANCELLED_VIDEO_FINALIZE_TIMEOUT_MS = ROTATION_STOP_TIMEOUT_MS;

/** One way to tear down a cancelled plan's recording, bounded by {@link runShieldedTeardown}. */
export interface CancelledVideoTeardown {
  label: string;
  capMs: number;
  run: () => Promise<FinalizedVideo>;
  /** What survives when `run` fails or hits its cap. */
  salvage: () => Promise<FinalizedVideo>;
  successWarning: string;
}

export const getDeviceType = (device: BootedDevice): "emulator" | "simulator" | "device" => {
  if (device.platform === "android") {
    return device.deviceId.startsWith("emulator-") ? "emulator" : "device";
  }
  return device.deviceId.includes("-") && device.deviceId.length > 30 ? "simulator" : "device";
};

export const sharedTestExecutionRepository = new TestExecutionRepository();

export const rethrowDeviceLoss = (error: unknown): void => {
  if (isDeviceLostError(error)) {
    throw error;
  }
};

/**
 * The `warnings` field of an `executePlan` response, or nothing when the plan
 * produced none (#6887 review).
 */
export function planWarningsField(warnings: PlanStepWarnings[] | undefined): {
  warnings?: PlanStepWarnings[];
} {
  return warnings?.length ? { warnings } : {};
}

/** The skippedSteps response field, omitted when no optional steps were skipped. */
export function planSkippedStepsField(skippedSteps: PlanSkippedStep[] | undefined): {
  skippedSteps?: PlanSkippedStep[];
} {
  return skippedSteps?.length ? { skippedSteps } : {};
}

/** The toolResults response field, omitted when no completed step produced an object payload. */
export function planToolResultsField(toolResults: PlanStepToolResult[] | undefined): {
  toolResults?: PlanStepToolResult[];
} {
  return toolResults?.length ? { toolResults } : {};
}

/** The toolResultsTruncated marker, present only when the plan's shared budget ran out. */
export function planToolResultsTruncatedField(truncated: PlanToolResultsTruncation | undefined): {
  toolResultsTruncated?: PlanToolResultsTruncation;
} {
  return truncated ? { toolResultsTruncated: truncated } : {};
}

/**
 * The typed refusal fields of an error that failed the plan, so a typed retryable refusal (e.g.
 * `capacity_exhausted` from device allocation) is not flattened into the `error` string (#11236).
 * A refusal with its own wire payload also keeps that evidence (`deviceLabel`, `reason`,
 * `scopeKey`, ...), so a client can branch on fields instead of parsing the message (#11421).
 */
export function planRefusalFields(
  error: unknown,
): Pick<ExecutePlanResult, "code" | "retryable" | "retryAfterMs" | "nextAction" | "details"> &
  Record<string, unknown> {
  const fields = typedRefusalFields(error);
  return fields ? { ...refusalPayloadEvidence(error, fields.details ?? {}), ...fields } : {};
}

/**
 * The typed outcome of a plan that daemon shutdown cut (#11572): the shutdown aborts the plan's
 * call and releases its sessions, and the plan still answers with its own result, so that result
 * carries `daemon_shutting_down` and `retryable: true` like every call the shutdown answers itself.
 * The caller runs the plan again against the restarted daemon; its derived label sessions are
 * minted by that run. Steps may already have run, as `executedSteps` reports.
 */
export function planShutdownInterruptionFields(
  signal: AbortSignal | undefined,
  planSucceeded = false,
): Pick<ExecutePlanResult, "code" | "retryable"> {
  const sessionManager =
    planSucceeded || !signal?.aborted ? undefined : defaultDaemonContext.sessionManager();
  if (!sessionManager || sessionManager.isAcceptingSessionCreations()) {
    return {};
  }
  return { code: DAEMON_SHUTTING_DOWN_ERROR_CODE, retryable: true };
}

/**
 * The typed outcome of a failed plan whose base session ended while it ran (#11640): the base's
 * end ends its labels, so the plan's next step is refused with the base's terminal release and
 * the result says so in fields, `session_ownership_lost` with the base's release reason, instead
 * of leaving the caller to parse the failed step's message. A plan's steps on a label do not keep
 * its base alive; the plan's own call does, until that call's request deadline.
 */
export function planBaseEndFields(
  baseSessionUuid: string | undefined,
  planSucceeded: boolean,
  failedStep?: PlanExecutionResult["failedStep"],
  daemon: PlanEndDaemonContext = defaultDaemonContext,
): Pick<ExecutePlanResult, "code" | "retryable" | "nextAction" | "details"> {
  const manager = daemon.sessionManager();
  if (planSucceeded || !baseSessionUuid || !failedStep || !manager) {
    return {};
  }
  const ended = manager.peekTerminalAnswerForEndedSession(baseSessionUuid);
  if (!ended) {
    return {};
  }
  // The executor retains only the failed step's string, not its thrown error. Match the exact
  // terminal answer, never infer causality from the base merely having expired (#11640).
  const labelEnd = failedStep.device
    ? manager.peekTerminalAnswerForEndedSession(`${baseSessionUuid}:${failedStep.device}`)
    : undefined;
  if (
    failedStep.error !== String(ended) &&
    !(
      labelEnd?.release.releaseReason === ended.release.releaseReason &&
      failedStep.error === String(labelEnd)
    )
  ) {
    return {};
  }
  return {
    code: SESSION_OWNERSHIP_LOST_CODE,
    retryable: false,
    nextAction: ACQUIRE_NEW_SESSION_NEXT_ACTION,
    details: {
      sessionUuid: ended.sessionUuid,
      reason: ended.release.releaseReason,
      ...idleReleaseField(ended.release.releaseReason),
    },
  };
}

/**
 * The evidence a thrown `tools/call` gives the same refusal, read from `shapeToolCallError`'s
 * payload so the two surfaces cannot drift. `success` and `error` are the plan result's own, and
 * fields `details` already carries are not repeated beside it.
 */
export function refusalPayloadEvidence(
  error: unknown,
  details: Record<string, unknown>,
): Record<string, unknown> {
  if (!isTypedToolRefusal(error)) {
    return {};
  }
  const wire: unknown = JSON.parse(
    shapeToolCallError(error, { toolName: "executePlan", source: "MCP" }).content[0].text,
  );
  if (typeof wire !== "object" || wire === null || typeof Reflect.get(wire, "code") !== "string") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(wire).filter(
      ([key]) => key !== "success" && key !== "error" && !(key in details),
    ),
  );
}

/** The deviceFailures response field, omitted when no device failures were reported. */
export function planDeviceFailuresField(deviceFailures: PlanDeviceFailure[] | undefined): {
  deviceFailures?: PlanDeviceFailure[];
} {
  return deviceFailures?.length ? { deviceFailures } : {};
}

/**
 * Converts debug step traces from PlanExecutor into the row shape expected by
 * TestExecutionRepository. Exported for unit testing — used to be inlined.
 */
export function convertDebugStepsToRecords(
  debugSteps: ExecutePlanStepDebugInfo[] | undefined,
): TestStepRecord[] {
  if (!debugSteps || debugSteps.length === 0) {
    return [];
  }

  return debugSteps.map((step, index) => {
    const toolMatch = step.step.match(/:\s*(\w+)$/);
    const action = toolMatch ? toolMatch[1] : step.step;

    const details = step.details as
      | { params?: Record<string, unknown>; error?: string }
      | undefined;

    return {
      stepIndex: index,
      action,
      target: buildStepRecordTarget(details?.params),
      status: step.status,
      durationMs: step.durationMs,
      screenName: null,
      screenshotPath: null,
      errorMessage: details?.error ?? null,
      details: step.details,
    };
  });
}

export function buildStepRecordTarget(
  params: { text?: unknown; elementId?: unknown; direction?: unknown } | undefined,
): string | null {
  if (!params) {
    return null;
  }
  if (params.text) {
    return `text="${params.text}"`;
  }
  if (params.elementId) {
    return `id="${params.elementId}"`;
  }
  if (params.direction) {
    return `direction=${params.direction}`;
  }
  return null;
}

export function convertPerDeviceSkippedStepsToRecords(
  perDeviceResults: PlanExecutionResult["perDeviceResults"] | undefined,
): TestStepRecord[] {
  if (!perDeviceResults) {
    return [];
  }

  const skippedRecords: TestStepRecord[] = [];
  for (const deviceResult of perDeviceResults.values()) {
    for (const skippedStep of deviceResult.skippedSteps ?? []) {
      const details = skippedStep.details as
        | { params?: Record<string, unknown>; error?: string }
        | undefined;
      skippedRecords.push({
        stepIndex: skippedStep.stepIndex,
        action: skippedStep.tool,
        target: buildStepRecordTarget(details?.params),
        status: "skipped",
        durationMs: skippedStep.durationMs,
        screenName: null,
        screenshotPath: null,
        errorMessage: skippedStep.error,
        details: {
          device: deviceResult.device,
          trackIndex: skippedStep.trackIndex,
          ...(skippedStep.details ?? {}),
        },
      });
    }
  }

  return skippedRecords.sort(
    (a, b) => a.stepIndex - b.stepIndex || a.action.localeCompare(b.action),
  );
}
