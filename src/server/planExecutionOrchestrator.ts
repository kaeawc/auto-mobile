import {
  ActionableError,
  BootedDevice,
  ExecutePlanResult,
  Platform,
  PlanExecutionResult,
  type VideoRecordingMetadata,
} from "../models";
import {
  ExecutePlanStepDebugInfo,
  PlanExecutionOptions,
  type PlanStepWarnings,
  type PlanSkippedStep,
  type PlanDeviceFailure,
} from "../models/ExecutePlanResult";
import {
  TestExecutionRepository,
  TestExecutionStatus,
  TestStepRecord,
} from "../db/testExecutionRepository";
import { PlanPartitioner } from "../utils/plan/PlanPartitioner";
import { PlanSchemaValidator } from "../utils/plan/PlanSchemaValidator";
import { normalizePlanDevices } from "../utils/plan/PlanDevices";

type NormalizedPlanDevices = ReturnType<typeof normalizePlanDevices>;
import { buildDeviceLabelMap, registerDeviceLabelMap } from "./deviceLabelMapping";
import { importPlanFromYaml, executePlan } from "../utils/planUtils";
import { DaemonState } from "../daemon/daemonState";
import type { DevicePool } from "../daemon/devicePool";
import type { SessionManager } from "../daemon/sessionManager";
import {
  AndroidSegmentedPlanVideoSession,
  ROTATION_STOP_TIMEOUT_MS,
  type SegmentedSessionResult,
} from "./androidSegmentedPlanVideoSession";
import { daemonPlanDeviceOwnership, type PlanDeviceOwnership } from "./planDeviceOwnership";
import { type StoppedSegment, writeSegmentManifest } from "./segmentManifest";
import {
  getVideoRecordingMetadata as defaultGetVideoRecordingMetadata,
  getVideoRecordingStatus as defaultGetVideoRecordingStatus,
  rollbackVideoRecordingStart as defaultRollbackVideoRecordingStart,
  startVideoRecording as defaultStartVideoRecording,
  stopVideoRecording as defaultStopVideoRecording,
} from "./videoRecordingManager";
import { serverConfig } from "../utils/ServerConfig";
import { defaultTimer, Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { ProgressCallback } from "./toolRegistry";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import type { Plan } from "../models/Plan";
import { isDeviceLostError } from "./deviceLossOutcome";
import { errorMessage } from "../utils/describeUnknownError";
import { runWithAbortSignal } from "../utils/AbortContext";
import { raceWithDeadline } from "../utils/raceWithDeadline";

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
  testExecutionRepository?: TestExecutionRepository;
  /** Clock + scheduled-task primitives, replaced by FakeTimer in tests. */
  timer?: Timer;
  /** Video recording manager surface — replaced by a fake in tests. */
  videoRecorder?: VideoRecorder;
  /** Whether the plan's session still holds its device at teardown — replaced by a fake in tests. */
  deviceOwnership?: PlanDeviceOwnership;
}

interface VideoState {
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

interface FinalizedVideo {
  videoFilePaths: string[];
  videoRecordingIds: string[];
  videoWarnings?: string[];
}

type ExecutionContext = {
  device: BootedDevice;
  request: PlanExecutionRequest;
  progress?: ProgressCallback;
  signal?: AbortSignal;
};

const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_IOS_VIDEO_MAX_DURATION_SECONDS = 300;
// Allow small timestamp skew between backend completion and the orchestrator stop attempt.
const IOS_VIDEO_PLAN_END_TOLERANCE_MS = 100;
/**
 * Bound on discarding a cancelled plan's recording after its session released the
 * device (#9885). The discard is a host process reap plus our own device temp file's
 * `rm -f` and row deletes, which takes well under a second when the device answers;
 * this caps a wedged device so a cancelled `executePlan` still returns promptly.
 */
const CANCELLED_VIDEO_DISCARD_TIMEOUT_MS = 5_000;
/**
 * Overall bound on stopping and pulling the recording of a plan cancelled while its
 * session still owns the device (deadline, client cancel). It is the existing budget
 * for one whole segment stop-and-pull (rotation's `ROTATION_STOP_TIMEOUT_MS`, the
 * 10 s between screenrecord's 180 s cap and the 170 s rotation), applied once to the
 * whole teardown rather than per segment.
 */
const CANCELLED_VIDEO_FINALIZE_TIMEOUT_MS = ROTATION_STOP_TIMEOUT_MS;

/** One way to tear down a cancelled plan's recording, bounded by {@link runShieldedTeardown}. */
interface CancelledVideoTeardown {
  label: string;
  capMs: number;
  run: () => Promise<FinalizedVideo>;
  /** What survives when `run` fails or hits its cap. */
  salvage: () => Promise<FinalizedVideo>;
  successWarning: string;
}

const getDeviceType = (device: BootedDevice): "emulator" | "simulator" | "device" => {
  if (device.platform === "android") {
    return device.deviceId.startsWith("emulator-") ? "emulator" : "device";
  }
  return device.deviceId.includes("-") && device.deviceId.length > 30 ? "simulator" : "device";
};

const sharedTestExecutionRepository = new TestExecutionRepository();

const rethrowDeviceLoss = (error: unknown): void => {
  if (isDeviceLostError(error)) {
    throw error;
  }
};

/**
 * The `warnings` field of an `executePlan` response, or nothing when the plan
 * produced none (#6887 review).
 */
function planWarningsField(warnings: PlanStepWarnings[] | undefined): {
  warnings?: PlanStepWarnings[];
} {
  return warnings?.length ? { warnings } : {};
}

/** The skippedSteps response field, omitted when no optional steps were skipped. */
function planSkippedStepsField(skippedSteps: PlanSkippedStep[] | undefined): {
  skippedSteps?: PlanSkippedStep[];
} {
  return skippedSteps?.length ? { skippedSteps } : {};
}

/** The deviceFailures response field, omitted when no device failures were reported. */
function planDeviceFailuresField(deviceFailures: PlanDeviceFailure[] | undefined): {
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

function buildStepRecordTarget(
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

/**
 * Orchestrates a single executePlan invocation end-to-end.
 *
 * Phases (each is a private method, all tested in isolation):
 *   1. {@link preparePlan} — base64 decode, schema validation, YAML parse, device-list reconcile
 *   2. {@link allocateDevices} — multi-device upfront allocation with shared timeout
 *   3. {@link startVideoRecording} — Android segmented OR iOS single-file recording
 *   4. {@link runPlan} — delegates to planUtils.executePlan with the right options
 *   5. {@link finalizeVideo} — stops/finalizes recording (always runs in finally)
 *   6. {@link recordExecution} — writes a row to the test-execution timing DB
 *
 * The progress heartbeat (keeps SSE stream alive during long plans) and the
 * top-level try/catch (so the tool always returns a structured response, never
 * throws) wrap the whole sequence in {@link execute}.
 */
export class PlanExecutionOrchestrator {
  private readonly device: BootedDevice;
  private readonly request: PlanExecutionRequest;
  private readonly progress?: ProgressCallback;
  private readonly signal?: AbortSignal;
  private readonly timer: Timer;
  private readonly testExecutionRepository: TestExecutionRepository;
  private readonly createSchemaValidator: () => Pick<
    PlanSchemaValidator,
    "loadSchema" | "validateYaml"
  >;
  private readonly videoRecorder: VideoRecorder;
  private readonly deviceOwnership: PlanDeviceOwnership;

  // Set in execute(); used by all phase methods for [PERF +Xms] elapsed-time logs.
  private perfStart = 0;
  // Computed once in preparePlan(); reused by allocateDevices().
  private normalizedDevices?: NormalizedPlanDevices;

  constructor(context: ExecutionContext, deps: PlanExecutionDependencies = {}) {
    this.device = context.device;
    this.request = context.request;
    this.progress = context.progress;
    this.signal = context.signal;
    this.timer = deps.timer ?? defaultTimer;
    this.testExecutionRepository = deps.testExecutionRepository ?? sharedTestExecutionRepository;
    this.createSchemaValidator = deps.createSchemaValidator ?? (() => new PlanSchemaValidator());
    this.deviceOwnership = deps.deviceOwnership ?? daemonPlanDeviceOwnership;
    this.videoRecorder = deps.videoRecorder ?? {
      startVideoRecording: defaultStartVideoRecording,
      stopVideoRecording: defaultStopVideoRecording,
      getVideoRecordingStatus: defaultGetVideoRecordingStatus,
      getVideoRecordingMetadata: defaultGetVideoRecordingMetadata,
      rollbackVideoRecordingStart: defaultRollbackVideoRecordingStart,
    };
  }

  private perfLog(message: string): void {
    logger.info(`[PERF +${this.timer.now() - this.perfStart}ms] ${message}`);
  }

  /**
   * Run all phases, returning a structured ExecutePlanResult for ordinary plan
   * failures. Device-loss cancellation is rethrown for the MCP boundary to
   * report as an infrastructure outcome.
   */
  async execute(): Promise<ExecutePlanResult> {
    const startTime = this.timer.now();
    const stopHeartbeat = this.startProgressHeartbeat();

    try {
      this.perfStart = this.timer.now();
      logger.info("=== Starting executePlanTool ===");
      logger.info(
        `[PERF +0ms] Device: ${this.device.platform} (${this.device.deviceId}), ` +
          `Start Step: ${this.request.startStep}, SessionUUID: ${this.request.sessionUuid}`,
      );

      const plan = await this.preparePlan();

      // Enable the plan-execution guard BEFORE allocation. Allocation can
      // auto-boot a simulator, and the device-disconnect monitor must not prune
      // a just-booted device out from under it (otherwise allocation fails with
      // "no devices match criteria"). The finally always releases this lease, even
      // if allocation or video startup throws.
      const planExecutionLease = serverConfig.acquirePlanExecutionLease();

      let deviceMapping: Record<string, string> | undefined;
      let video: VideoState | undefined;
      let result: PlanExecutionResult | undefined;
      let finalizedVideo: FinalizedVideo = { videoFilePaths: [], videoRecordingIds: [] };

      try {
        deviceMapping = await this.allocateDevices(plan);
        video = await this.startVideoRecording(plan);
        result = await this.runPlan(plan, video);
      } finally {
        planExecutionLease.release();
        if (video !== undefined) {
          finalizedVideo = await this.finalizeVideo(video);
        }
      }

      if (!result) {
        throw new Error("Plan execution failed without producing a result");
      }

      const recordedSteps = [
        ...convertDebugStepsToRecords(result.debug?.steps),
        ...convertPerDeviceSkippedStepsToRecords(result.perDeviceResults),
      ];
      await this.recordExecution(result.success ? "passed" : "failed", startTime, {
        steps: recordedSteps,
        errorMessage: result.failedStep?.error ?? undefined,
        videoPath: finalizedVideo.videoFilePaths[0],
      });

      const response: ExecutePlanResult = {
        success: result.success,
        executedSteps: result.executedSteps,
        totalSteps: result.totalSteps,
        failedStep: result.failedStep,
        error: result.failedStep ? result.failedStep.error : undefined,
        platform: this.device.platform,
        deviceId: this.device.deviceId,
        deviceMapping,
        ...(this.request.captureObserveSteps && result.debug ? { debug: result.debug } : {}),
        // Best-effort warnings, including from failed or skipped sections, are NOT gated on
        // captureObserveSteps: the debug trace is an opt-in diagnostic, while a
        // keyboard that would not dismiss changes what every later step saw
        // (#6887 review).
        ...planWarningsField(result.warnings),
        ...planSkippedStepsField(result.skippedSteps),
        ...planDeviceFailuresField(result.deviceFailures),
        videoWarnings: finalizedVideo.videoWarnings,
        ...(finalizedVideo.videoFilePaths.length > 0
          ? {
              videoFilePaths: finalizedVideo.videoFilePaths,
              videoRecordingIds: finalizedVideo.videoRecordingIds,
            }
          : {}),
      };

      this.perfLog(`Returning from executePlanTool (deviceId=${this.device.deviceId})`);
      return response;
    } catch (error) {
      rethrowDeviceLoss(error);
      logger.error(`[PERF] Failed to execute plan: ${error}`);

      await this.recordExecution("failed", startTime, {
        errorMessage: String(error),
      });

      const response: ExecutePlanResult = {
        success: false,
        executedSteps: 0,
        totalSteps: 0,
        error: `${error}`,
        platform: this.device.platform,
        deviceId: this.device.deviceId,
      };

      logger.info(`[PERF] Returning error from executePlanTool (deviceId=${this.device.deviceId})`);
      return response;
    } finally {
      stopHeartbeat();
    }
  }

  /**
   * Decode (base64 if needed), validate schema, parse YAML, normalize devices,
   * and reconcile any `devices` arg against the plan's own device declarations.
   */
  private async preparePlan(): Promise<Plan> {
    let yamlContent = this.request.planContent;

    if (yamlContent.startsWith("base64:")) {
      this.perfLog("Decoding base64 plan content");
      yamlContent = Buffer.from(yamlContent.substring(7), "base64").toString("utf-8");
      this.perfLog(`Base64 content decoded (${yamlContent.length} bytes)`);
    }

    this.perfLog("Validating plan YAML schema");
    const validator = this.createSchemaValidator();
    await validator.loadSchema();
    const validation = validator.validateYaml(yamlContent);
    if (!validation.valid) {
      const errorMessages =
        validation.errors
          ?.map(
            (err) =>
              `${err.field}: ${err.message}${err.line !== undefined ? ` (line ${err.line})` : ""}`,
          )
          .join("\n") || "Unknown validation error";

      throw new ActionableError(
        `Plan YAML validation failed:\n${errorMessages}\n\n` +
          "The plan does not conform to the AutoMobile test plan schema. " +
          "Check the schema at schemas/test-plan.schema.json for details.",
      );
    }
    this.perfLog("Plan YAML schema validation passed");

    this.perfLog("Parsing plan from YAML");
    const plan = importPlanFromYaml(yamlContent);
    this.perfLog(`Plan parsed: '${plan.name}' with ${plan.steps.length} steps`);

    this.normalizedDevices = normalizePlanDevices(plan.devices);
    this.reconcileDeviceLists();
    return plan;
  }

  private reconcileDeviceLists(): void {
    const planDeviceLabels = this.normalizedDevices?.labels ?? [];
    const provided = this.request.devices;

    if (provided && planDeviceLabels.length > 0) {
      const declaredSorted = [...new Set(planDeviceLabels)].sort();
      const providedSorted = [...new Set(provided)].sort();
      const same =
        declaredSorted.length === providedSorted.length &&
        declaredSorted.every((label, index) => label === providedSorted[index]);
      if (!same) {
        throw new ActionableError(
          `Devices list does not match plan devices. ` +
            `Plan devices: [${declaredSorted.join(", ")}], provided: [${providedSorted.join(", ")}].`,
        );
      }
    }
  }

  /**
   * Allocate devices upfront for multi-device plans. Returns the label→deviceId
   * mapping used in the final response, or undefined when this is a single-device
   * plan with no labels.
   */
  private async allocateDevices(_plan: Plan): Promise<Record<string, string> | undefined> {
    const normalized = this.normalizedDevices ?? normalizePlanDevices();
    const planDeviceLabels = normalized.labels;
    const effectiveLabels =
      this.request.devices && this.request.devices.length > 0
        ? this.request.devices
        : planDeviceLabels;

    if (effectiveLabels.length === 0) {
      if (this.request.device) {
        throw new ActionableError("Device label requires a devices list to be provided.");
      }
      return undefined;
    }

    const sessionUuid = this.request.sessionUuid;
    if (!sessionUuid) {
      throw new ActionableError("Device labels require a sessionUuid to be provided.");
    }
    if (this.request.device && !effectiveLabels.includes(this.request.device)) {
      throw new ActionableError(
        `Device label '${this.request.device}' was not declared in devices list: ${effectiveLabels.join(", ")}`,
      );
    }

    this.perfLog("Allocating devices upfront");

    if (!DaemonState.getInstance().isInitialized()) {
      throw new ActionableError("Multi-device plans require an active daemon session.");
    }

    const devicePool = DaemonState.getInstance().getDevicePool();
    const sessionManager = DaemonState.getInstance().getSessionManager();
    const labelToSessionMap = buildDeviceLabelMap(
      effectiveLabels,
      sessionUuid,
      this.request.device,
    );
    const sessionIds = Object.values(labelToSessionMap);

    // The plan execution is tracked on its base session. Publish its derived
    // label-session ownership before the allocator's first await so heartbeat
    // and idle cleanup keep partial allocations alive while this plan runs.
    const previousDeviceLabels = sessionManager.getDeviceLabels(sessionUuid);
    sessionManager.setDeviceLabels(sessionUuid, labelToSessionMap);

    logger.info(
      `Requesting allocation of ${sessionIds.length} devices for labels: ${Object.keys(labelToSessionMap).join(", ")} ` +
        `(timeout: ${this.request.deviceAllocationTimeoutMs / 1000}s)`,
    );

    const restorePreviousDeviceLabels = (error: unknown): never => {
      if (previousDeviceLabels) {
        sessionManager.setDeviceLabels(sessionUuid, previousDeviceLabels);
      } else {
        sessionManager.clearSessionCache(sessionUuid, "deviceLabels");
      }
      throw error;
    };

    const allocation = Promise.resolve().then(() =>
      this.requestDeviceAllocation(
        devicePool,
        normalized,
        effectiveLabels,
        labelToSessionMap,
        sessionIds,
      ),
    );

    const sessionToDeviceMap = await allocation.catch((error) => {
      return restorePreviousDeviceLabels(error);
    });

    const deviceMapping = this.buildDeviceMapping(
      sessionManager,
      sessionToDeviceMap,
      labelToSessionMap,
    );

    this.perfLog("Device allocation complete");
    for (const [label, deviceId] of Object.entries(deviceMapping)) {
      const sessionUuid = labelToSessionMap[label];
      this.perfLog(`  ${label} → ${deviceId} (session: ${sessionUuid})`);
    }

    await registerDeviceLabelMap(
      sessionUuid,
      effectiveLabels,
      this.request.device,
      { keepScreenAwake: this.request.keepScreenAwake, platform: this.request.platform },
      getToolSelectionContext()?.execution,
      this.signal,
    );

    return deviceMapping;
  }

  private requestDeviceAllocation(
    devicePool: DevicePool,
    normalized: NormalizedPlanDevices,
    effectiveLabels: string[],
    labelToSessionMap: Record<string, string>,
    sessionIds: string[],
  ): Promise<Map<string, string>> {
    if (!normalized.hasDefinitions) {
      return devicePool.assignMultipleDevices(
        sessionIds,
        this.request.deviceAllocationTimeoutMs,
        this.request.platform,
      );
    }

    const definitionMap = new Map(
      normalized.definitions.map((definition) => [definition.label, definition]),
    );
    const requests = effectiveLabels.map((label) => {
      const definition = definitionMap.get(label);
      if (!definition) {
        throw new ActionableError(
          `Device definition for label '${label}' not found in plan devices.`,
        );
      }
      return {
        sessionId: labelToSessionMap[label],
        criteria: {
          platform: definition.platform,
          simulatorType: definition.simulatorType,
          iosVersion: definition.iosVersion,
        },
      };
    });

    return devicePool.assignMultipleDevicesByCriteria(
      requests,
      this.request.deviceAllocationTimeoutMs,
    );
  }

  private buildDeviceMapping(
    sessionManager: SessionManager,
    sessionToDeviceMap: Map<string, string>,
    labelToSessionMap: Record<string, string>,
  ): Record<string, string> {
    for (const sessionUuid of sessionToDeviceMap.keys()) {
      if (!sessionManager.getSession(sessionUuid)) {
        throw new ActionableError(
          `Internal error: Session ${sessionUuid} not found after device allocation`,
        );
      }
    }

    const deviceMapping: Record<string, string> = {};
    for (const [label, sessionUuid] of Object.entries(labelToSessionMap)) {
      const deviceId = sessionToDeviceMap.get(sessionUuid);
      if (!deviceId) {
        throw new ActionableError(
          `Internal error: No device allocated for session ${sessionUuid} (label: ${label})`,
        );
      }
      deviceMapping[label] = deviceId;
    }
    return deviceMapping;
  }

  /**
   * Start automatic plan video recording. Failures are logged and swallowed —
   * a failing recording must never abort plan execution.
   */
  private async startVideoRecording(plan: Plan): Promise<VideoState> {
    const videoOutputPrefix = `test-${plan.name}-${this.timer.now()}`;
    const state: VideoState = {};

    try {
      this.perfLog("Starting automatic video recording for test");
      if (this.device.platform === "android") {
        const session = new AndroidSegmentedPlanVideoSession({
          device: this.device,
          outputNamePrefix: videoOutputPrefix,
          // Share the orchestrator's clock so step-driven rotation timing is deterministic
          // under test (in production both are the real defaultTimer, so no behavior change).
          timer: this.timer,
          // Route each segment's capture through the injected recorder so tests can
          // drive the Android plan path with fakes (production passes the real manager).
          startVideoRecording: this.videoRecorder.startVideoRecording,
          stopVideoRecording: this.videoRecorder.stopVideoRecording,
          ...(this.videoRecorder.rollbackVideoRecordingStart
            ? { rollbackVideoRecordingStart: this.videoRecorder.rollbackVideoRecordingStart }
            : {}),
        });
        // Sequential plans rotate between steps (never mid-step). A partitioned plan's tracks
        // run concurrently, so no step boundary is quiescent and executeDeviceTrack never calls
        // the hook; the session's own timer rotates instead, and one session-level timer cannot
        // be raced by several tracks. That mid-step rotation stops and pulls one segment before
        // starting the next, so frames between them are lost (bounded per leg, reported as a
        // "Video gap" warning); sequential plans rotate between steps instead.
        state.androidTimerDriven = PlanPartitioner.isMultiDevicePlan(plan);
        await (state.androidTimerDriven ? session.start() : session.startFirstSegment());
        state.androidSession = session;
        this.perfLog("Android segmented video recording started");
      } else {
        const recording = await this.videoRecorder.startVideoRecording({
          device: this.device,
          outputName: videoOutputPrefix,
          maxDurationSeconds: DEFAULT_IOS_VIDEO_MAX_DURATION_SECONDS,
        });
        state.iosRecordingId = recording.recordingId;
        this.perfLog(`Video recording started: ${recording.recordingId}`);
      }
    } catch (videoError) {
      const warning = `Failed to start automatic video recording: ${errorMessage(videoError)}`;
      logger.warn(`[PERF +${this.timer.now() - this.perfStart}ms] ${warning}`, videoError);
      state.warnings = [warning];
    }

    return state;
  }

  private async runPlan(plan: Plan, video: VideoState): Promise<PlanExecutionResult> {
    const planExecutionOptions = this.buildPlanExecutionOptions(video);
    this.perfLog(
      `Starting plan execution on device ${this.device.deviceId} (${this.device.platform})`,
    );
    // Note: the plan-execution guard is enabled earlier in execute(), before
    // device allocation, so the disconnect monitor is already suppressed here.
    const result = await executePlan(
      plan,
      this.request.startStep,
      this.request.platform,
      this.device.deviceId,
      this.request.sessionUuid,
      this.signal,
      this.request.abortStrategy,
      planExecutionOptions,
    );
    this.perfLog(
      `Plan execution completed: ${result.success ? "SUCCESS" : "FAILED"} ` +
        `(${result.executedSteps}/${result.totalSteps} steps)`,
    );
    return result;
  }

  private buildPlanExecutionOptions(video: VideoState): PlanExecutionOptions | undefined {
    const options: PlanExecutionOptions = {};
    if (this.request.captureObserveSteps) {
      options.captureObserveSteps = this.request.captureObserveSteps;
    }
    if (video.androidSession && !video.androidTimerDriven) {
      options.onBeforePlanStep = video.androidSession.onBeforePlanStep;
    }
    return Object.keys(options).length > 0 ? options : undefined;
  }

  private async finalizeVideo(video: VideoState): Promise<FinalizedVideo> {
    if (this.signal?.aborted && (video.androidSession || video.iosRecordingId)) {
      return this.finalizeCancelledVideo(video);
    }
    return this.finalizeRunningVideo(video);
  }

  /** Stops, pulls and packages the recording the way an uncancelled plan does. */
  private async finalizeRunningVideo(video: VideoState): Promise<FinalizedVideo> {
    if (video.androidSession) {
      return this.finalizeWithFallback(
        "Finalizing segmented video recording",
        "Failed to finalize segmented video",
        async () => {
          return this.packageAndroidVideo(await video.androidSession!.finalize());
        },
        video.warnings,
      );
    }
    if (video.iosRecordingId) {
      const recordingId = video.iosRecordingId;
      return this.finalizeWithFallback(
        `Stopping automatic video recording: ${recordingId}`,
        "Failed to stop automatic video recording",
        async () => {
          let stopResult: Awaited<ReturnType<VideoRecorder["stopVideoRecording"]>>;
          const planEndMs = this.timer.now();
          try {
            stopResult = await this.videoRecorder.stopVideoRecording(recordingId);
          } catch (error) {
            logger.warn(`Plan video stop failed for ${recordingId}: ${errorMessage(error)}`);
            const recovered = await this.recoverCompletedIosVideo(recordingId, planEndMs);
            if (recovered) {
              return recovered;
            }
            throw error;
          }
          this.perfLog(`Video recording stopped successfully: ${stopResult.metadata.filePath}`);
          return {
            videoFilePaths: [stopResult.metadata.filePath],
            videoRecordingIds: [recordingId],
          };
        },
        video.warnings,
      );
    }
    return {
      videoFilePaths: [],
      videoRecordingIds: [],
      ...(video.warnings?.length ? { videoWarnings: [...new Set(video.warnings)] } : {}),
    };
  }

  /** Packages a segmented session's result, with the best-effort on-disk manifest. */
  private async packageAndroidVideo(finalized: SegmentedSessionResult): Promise<FinalizedVideo> {
    const videoWarnings = [
      ...new Set([
        ...(finalized.warnings ?? []),
        ...finalized.metadata.flatMap((metadata) => metadata.warnings ?? []),
      ]),
    ];
    this.perfLog(`Segmented video finalized (${finalized.filePaths.length} file(s))`);
    // Best-effort manifest so a plan run's ordered segments are discoverable on disk,
    // matching the raw videoRecording stop path (writeSegmentManifest logs-and-continues
    // on failure). The session handle is the first segment's recordingId, mirroring the
    // tool path's sessionId grouping.
    const segments: StoppedSegment[] = finalized.recordingIds.map((recordingId, index) => ({
      recordingId,
      filePath: finalized.filePaths[index],
      segmentIndex: index,
      ...(finalized.metadata[index]?.recordedPanel && {
        recordedPanel: finalized.metadata[index].recordedPanel,
      }),
      ...(finalized.metadata[index]?.transitions && {
        transitions: finalized.metadata[index].transitions,
      }),
      ...(finalized.metadata[index]?.warnings && {
        warnings: finalized.metadata[index].warnings,
      }),
    }));
    if (segments.length > 0) {
      await writeSegmentManifest(segments[0].recordingId, segments, videoWarnings);
    }
    return {
      videoFilePaths: finalized.filePaths,
      videoRecordingIds: finalized.recordingIds,
      ...(videoWarnings.length ? { videoWarnings } : {}),
    };
  }

  /**
   * Whether the plan's session still holds its device. The abort signal cannot say:
   * it also fires for a request deadline, a client cancel or disconnect, so only the
   * session/pool lookup tells a release from those (#9885 review). An ownership
   * lookup that fails is treated as "released", the choice that issues no device command.
   */
  private stillOwnsDevice(): boolean {
    const { sessionUuid } = this.request;
    if (!sessionUuid) {
      return true;
    }
    try {
      return this.deviceOwnership.ownsDevice(sessionUuid, this.device.deviceId);
    } catch (error) {
      logger.warn(
        `Could not determine device ownership for a cancelled plan: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
  }

  /**
   * A plan whose signal aborted: its video is neither thrown away nor pulled blindly.
   * The request signal is already aborted, so every adb call under it fails at once and
   * a graceful stop-and-pull only burns its waits (about 13.5 s measured, #9885); each
   * teardown below therefore runs under its own signal and bound instead.
   */
  private async finalizeCancelledVideo(video: VideoState): Promise<FinalizedVideo> {
    const owned = this.stillOwnsDevice();
    const teardown = this.cancelledVideoTeardown(video, owned);
    this.perfLog(
      owned
        ? "Plan cancelled while its session still owns the device; finalizing video"
        : "Plan cancelled after its device was released; discarding the active video segment",
    );
    let finalized: FinalizedVideo;
    let warning: string;
    try {
      finalized = await this.runShieldedTeardown(teardown);
      warning = teardown.successWarning;
    } catch (error) {
      logger.warn(`${teardown.label} failed: ${errorMessage(error)}`, error);
      finalized = await teardown.salvage();
      warning = `Plan was cancelled; ${teardown.label} did not complete: ${errorMessage(error)}`;
    }
    const videoWarnings = [
      ...new Set([...(video.warnings ?? []), ...(finalized.videoWarnings ?? []), warning]),
    ];
    return { ...finalized, videoWarnings };
  }

  private cancelledVideoTeardown(video: VideoState, owned: boolean): CancelledVideoTeardown {
    const { androidSession, iosRecordingId } = video;
    const rollback = this.videoRecorder.rollbackVideoRecordingStart;
    const empty: FinalizedVideo = { videoFilePaths: [], videoRecordingIds: [] };
    const salvage = async (): Promise<FinalizedVideo> =>
      androidSession ? this.packageAndroidVideo(androidSession.completedResult()) : empty;
    if (owned || (!androidSession && !(iosRecordingId && rollback))) {
      return {
        label: "Cancelled plan video finalize",
        capMs: CANCELLED_VIDEO_FINALIZE_TIMEOUT_MS,
        run: () => this.finalizeRunningVideo(video),
        salvage,
        successWarning: "Plan was cancelled; its video recording was finalized after cancellation",
      };
    }
    return {
      label: "Cancelled plan video discard",
      capMs: CANCELLED_VIDEO_DISCARD_TIMEOUT_MS,
      run: async () => {
        if (androidSession) {
          return this.packageAndroidVideo(await androidSession.finalizeWithoutDevice());
        }
        await rollback!(iosRecordingId!, { deviceWide: false });
        return empty;
      },
      salvage,
      successWarning:
        "Plan was cancelled after its device was released; its in-progress video segment was discarded",
    };
  }

  /**
   * Runs a teardown under a private abort signal, not the cancelled request's, and
   * bounded by its cap. The cap cannot cancel work already started, so reaching it
   * aborts the private signal, which fails every further adb call that honors the
   * ambient signal (exec and spawn do); calls already past that check, and host-side
   * database work, still run to completion. A failure after the cap is logged here,
   * once, since the caller has stopped waiting.
   */
  private async runShieldedTeardown(teardown: CancelledVideoTeardown): Promise<FinalizedVideo> {
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
        timer: this.timer,
        timeoutMs: teardown.capMs,
        label: teardown.label,
        onTimeout: () => {
          capped = true;
          shield.abort(
            new ActionableError(`${teardown.label} exceeded its ${teardown.capMs}ms cap`),
          );
        },
      }),
    );
  }

  private async recoverCompletedIosVideo(
    recordingId: string,
    planEndMs: number,
  ): Promise<FinalizedVideo | undefined> {
    const { getVideoRecordingStatus, getVideoRecordingMetadata } = this.videoRecorder;
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
      const videoWarnings = this.recoveredIosVideoWarnings(metadata, planEndMs);
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

  private recoveredIosVideoWarnings(metadata: VideoRecordingMetadata, planEndMs: number): string[] {
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
    const videoWarnings = [
      ...new Set([...(metadata.warnings ?? []), ...(warning ? [warning] : [])]),
    ];
    return videoWarnings;
  }

  private async finalizeWithFallback(
    startMessage: string,
    failureMessage: string,
    finalize: () => Promise<FinalizedVideo>,
    warnings: string[] = [],
  ): Promise<FinalizedVideo> {
    try {
      this.perfLog(startMessage);
      const result = await finalize();
      const videoWarnings = [...new Set([...warnings, ...(result.videoWarnings ?? [])])];
      return { ...result, ...(videoWarnings.length ? { videoWarnings } : {}) };
    } catch (videoError) {
      logger.warn(
        `[PERF +${this.timer.now() - this.perfStart}ms] ${failureMessage}: ${videoError}`,
      );
      return {
        videoFilePaths: [],
        videoRecordingIds: [],
        videoWarnings: [
          ...new Set([...warnings, `${failureMessage}: ${errorMessage(videoError)}`]),
        ],
      };
    }
  }

  private async recordExecution(
    status: TestExecutionStatus,
    startTime: number,
    options?: {
      steps?: TestStepRecord[];
      errorMessage?: string;
      videoPath?: string;
    },
  ): Promise<void> {
    if (!this.request.testMetadata) {
      return;
    }
    try {
      await this.testExecutionRepository.recordExecution({
        testClass: this.request.testMetadata.testClass,
        testMethod: this.request.testMetadata.testMethod,
        durationMs: this.timer.now() - startTime,
        status,
        timestamp: this.timer.now(),
        deviceId: this.device.deviceId,
        deviceName: this.device.name,
        devicePlatform: this.device.platform,
        deviceType: getDeviceType(this.device),
        appVersion: this.request.testMetadata.appVersion,
        gitCommit: this.request.testMetadata.gitCommit,
        targetSdk: this.request.testMetadata.targetSdk,
        jdkVersion: this.request.testMetadata.jdkVersion,
        jvmTarget: this.request.testMetadata.jvmTarget,
        gradleVersion: this.request.testMetadata.gradleVersion,
        isCi: this.request.testMetadata.isCi,
        sessionUuid: this.request.sessionUuid,
        errorMessage: options?.errorMessage,
        steps: options?.steps,
        videoPath: options?.videoPath,
      });
    } catch (error) {
      logger.warn(`Failed to record test execution timing: ${error}`);
    }
  }

  /**
   * Heartbeat keeps the SSE response stream alive during long plans (otherwise
   * idle streams can be silently dropped, causing MCP client timeouts even on
   * successful runs).
   */
  private startProgressHeartbeat(): () => void {
    if (!this.progress) {
      return () => {};
    }
    let stopped = false;
    let count = 0;
    const handle = this.timer.setInterval(() => {
      if (stopped) {
        return;
      }
      count++;
      this.progress!(count, undefined, "executing").catch((err) => {
        logger.debug(`[executePlan] Progress heartbeat delivery failed: ${err}`);
      });
    }, HEARTBEAT_INTERVAL_MS);
    return () => {
      stopped = true;
      this.timer.clearInterval(handle);
    };
  }
}
