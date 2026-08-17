import {
  ActionableError,
  BootedDevice,
  ExecutePlanResult,
  Platform,
  PlanExecutionResult
} from "../models";
import { ExecutePlanStepDebugInfo, PlanExecutionOptions } from "../models/ExecutePlanResult";
import { TestExecutionRepository, TestExecutionStatus, TestStepRecord } from "../db/testExecutionRepository";
import { PlanSchemaValidator } from "../utils/plan/PlanSchemaValidator";
import { normalizePlanDevices } from "../utils/plan/PlanDevices";

type NormalizedPlanDevices = ReturnType<typeof normalizePlanDevices>;
import { buildDeviceLabelMap, registerDeviceLabelMap } from "./deviceLabelMapping";
import { importPlanFromYaml, executePlan } from "../utils/planUtils";
import { DaemonState } from "../daemon/daemonState";
import { AndroidSegmentedPlanVideoSession } from "./androidSegmentedPlanVideoSession";
import { type StoppedSegment, writeSegmentManifest } from "./segmentManifest";
import {
  startVideoRecording as defaultStartVideoRecording,
  stopVideoRecording as defaultStopVideoRecording,
} from "./videoRecordingManager";
import { serverConfig } from "../utils/ServerConfig";
import { defaultTimer, Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { ProgressCallback } from "./toolRegistry";
import { getToolCapabilityContext } from "../features/toolCapabilities/toolCapabilityContext";
import type { Plan } from "../models/Plan";
import { isDeviceLostError } from "./deviceLossOutcome";

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
}

interface VideoState {
  androidSession?: AndroidSegmentedPlanVideoSession;
  iosRecordingId?: string;
}

interface FinalizedVideo {
  videoFilePaths: string[];
  videoRecordingIds: string[];
}

type ExecutionContext = {
  device: BootedDevice;
  request: PlanExecutionRequest;
  progress?: ProgressCallback;
  signal?: AbortSignal;
};

const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_IOS_VIDEO_MAX_DURATION_SECONDS = 300;

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
 * Converts debug step traces from PlanExecutor into the row shape expected by
 * TestExecutionRepository. Exported for unit testing — used to be inlined.
 */
export function convertDebugStepsToRecords(
  debugSteps: ExecutePlanStepDebugInfo[] | undefined
): TestStepRecord[] {
  if (!debugSteps || debugSteps.length === 0) {
    return [];
  }

  return debugSteps.map((step, index) => {
    const toolMatch = step.step.match(/:\s*(\w+)$/);
    const action = toolMatch ? toolMatch[1] : step.step;

    const details = step.details as { params?: Record<string, unknown>; error?: string } | undefined;

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

function buildStepRecordTarget(params: Record<string, unknown> | undefined): string | null {
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
  perDeviceResults: PlanExecutionResult["perDeviceResults"] | undefined
): TestStepRecord[] {
  if (!perDeviceResults) {
    return [];
  }

  const skippedRecords: TestStepRecord[] = [];
  for (const deviceResult of perDeviceResults.values()) {
    for (const skippedStep of deviceResult.skippedSteps ?? []) {
      const details = skippedStep.details as { params?: Record<string, unknown>; error?: string } | undefined;
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

  return skippedRecords.sort((a, b) => a.stepIndex - b.stepIndex || a.action.localeCompare(b.action));
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
  private readonly createSchemaValidator: () => Pick<PlanSchemaValidator, "loadSchema" | "validateYaml">;
  private readonly videoRecorder: VideoRecorder;

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
    this.videoRecorder = deps.videoRecorder ?? {
      startVideoRecording: defaultStartVideoRecording,
      stopVideoRecording: defaultStopVideoRecording,
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
        `Start Step: ${this.request.startStep}, SessionUUID: ${this.request.sessionUuid}`
      );

      const plan = await this.preparePlan();

      // Enable the plan-execution guard BEFORE allocation. Allocation can
      // auto-boot a simulator, and the device-disconnect monitor must not prune
      // a just-booted device out from under it (otherwise allocation fails with
      // "no devices match criteria"). The finally always clears the guard, even
      // if allocation or video startup throws.
      serverConfig.setPlanExecutionActive(true);

      let deviceMapping: Record<string, string> | undefined;
      let video: VideoState | undefined;
      let result: PlanExecutionResult | undefined;
      let finalizedVideo: FinalizedVideo = { videoFilePaths: [], videoRecordingIds: [] };

      try {
        deviceMapping = await this.allocateDevices(plan);
        video = await this.startVideoRecording(plan);
        result = await this.runPlan(plan, video);
      } finally {
        serverConfig.setPlanExecutionActive(false);
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
      const errorMessages = validation.errors?.map(err =>
        `${err.field}: ${err.message}${err.line !== undefined ? ` (line ${err.line})` : ""}`
      ).join("\n") || "Unknown validation error";

      throw new ActionableError(
        `Plan YAML validation failed:\n${errorMessages}\n\n` +
        "The plan does not conform to the AutoMobile test plan schema. " +
        "Check the schema at schemas/test-plan.schema.json for details."
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
          `Plan devices: [${declaredSorted.join(", ")}], provided: [${providedSorted.join(", ")}].`
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
    const normalized = this.normalizedDevices ?? { labels: [], hasDefinitions: false, definitions: [] };
    const planDeviceLabels = normalized.labels;
    const effectiveLabels = this.request.devices && this.request.devices.length > 0
      ? this.request.devices
      : planDeviceLabels;

    if (!effectiveLabels || effectiveLabels.length === 0) {
      if (this.request.device) {
        throw new ActionableError("Device label requires a devices list to be provided.");
      }
      return undefined;
    }

    if (!this.request.sessionUuid) {
      throw new ActionableError("Device labels require a sessionUuid to be provided.");
    }
    if (this.request.device && !effectiveLabels.includes(this.request.device)) {
      throw new ActionableError(
        `Device label '${this.request.device}' was not declared in devices list: ${effectiveLabels.join(", ")}`
      );
    }

    this.perfLog("Allocating devices upfront");

    if (!DaemonState.getInstance().isInitialized()) {
      throw new ActionableError("Multi-device plans require an active daemon session.");
    }

    const devicePool = DaemonState.getInstance().getDevicePool();
    const sessionManager = DaemonState.getInstance().getSessionManager();
    const labelToSessionMap = buildDeviceLabelMap(effectiveLabels, this.request.sessionUuid, this.request.device);
    const sessionIds = Object.values(labelToSessionMap);

    logger.info(
      `Requesting allocation of ${sessionIds.length} devices for labels: ${Object.keys(labelToSessionMap).join(", ")} ` +
      `(timeout: ${this.request.deviceAllocationTimeoutMs / 1000}s)`
    );

    let sessionToDeviceMap: Map<string, string>;
    if (normalized.hasDefinitions) {
      const definitionMap = new Map(
        normalized.definitions.map(definition => [definition.label, definition])
      );
      const requests = effectiveLabels.map(label => {
        const definition = definitionMap.get(label);
        if (!definition) {
          throw new ActionableError(
            `Device definition for label '${label}' not found in plan devices.`
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

      sessionToDeviceMap = await devicePool.assignMultipleDevicesByCriteria(
        requests,
        this.request.deviceAllocationTimeoutMs
      );
    } else {
      sessionToDeviceMap = await devicePool.assignMultipleDevices(
        sessionIds,
        this.request.deviceAllocationTimeoutMs,
        this.request.platform
      );
    }

    for (const sessionUuid of sessionToDeviceMap.keys()) {
      if (!sessionManager.getSession(sessionUuid)) {
        throw new ActionableError(
          `Internal error: Session ${sessionUuid} not found after device allocation`
        );
      }
    }

    const deviceMapping: Record<string, string> = {};
    for (const [label, sessionUuid] of Object.entries(labelToSessionMap)) {
      const deviceId = sessionToDeviceMap.get(sessionUuid);
      if (!deviceId) {
        throw new ActionableError(
          `Internal error: No device allocated for session ${sessionUuid} (label: ${label})`
        );
      }
      deviceMapping[label] = deviceId;
    }

    this.perfLog("Device allocation complete");
    for (const [label, deviceId] of Object.entries(deviceMapping)) {
      const sessionUuid = labelToSessionMap[label];
      this.perfLog(`  ${label} → ${deviceId} (session: ${sessionUuid})`);
    }

    await registerDeviceLabelMap(
      this.request.sessionUuid,
      effectiveLabels,
      this.request.device,
      { keepScreenAwake: this.request.keepScreenAwake, platform: this.request.platform },
      getToolCapabilityContext()?.execution,
    );

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
        });
        await session.startFirstSegment();
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
      logger.warn(`[PERF +${this.timer.now() - this.perfStart}ms] Failed to start automatic video recording: ${videoError}`);
    }

    return state;
  }

  private async runPlan(plan: Plan, video: VideoState): Promise<PlanExecutionResult> {
    const planExecutionOptions = this.buildPlanExecutionOptions(video);
    this.perfLog(`Starting plan execution on device ${this.device.deviceId} (${this.device.platform})`);
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
      planExecutionOptions
    );
    this.perfLog(
      `Plan execution completed: ${result.success ? "SUCCESS" : "FAILED"} ` +
      `(${result.executedSteps}/${result.totalSteps} steps)`
    );
    return result;
  }

  private buildPlanExecutionOptions(video: VideoState): PlanExecutionOptions | undefined {
    const options: PlanExecutionOptions = {};
    if (this.request.captureObserveSteps) {
      options.captureObserveSteps = this.request.captureObserveSteps;
    }
    if (video.androidSession) {
      options.onBeforePlanStep = video.androidSession.onBeforePlanStep;
    }
    return Object.keys(options).length > 0 ? options : undefined;
  }

  private async finalizeVideo(video: VideoState): Promise<FinalizedVideo> {
    if (video.androidSession) {
      return this.finalizeWithFallback(
        "Finalizing segmented video recording",
        "Failed to finalize segmented video",
        async () => {
          const finalized = await video.androidSession!.finalize();
          this.perfLog(`Segmented video finalized (${finalized.filePaths.length} file(s))`);
          // Best-effort manifest so a plan run's ordered segments are discoverable on disk,
          // matching the raw videoRecording stop path (writeSegmentManifest logs-and-continues
          // on failure). The session handle is the first segment's recordingId, mirroring the
          // tool path's sessionId grouping.
          const segments: StoppedSegment[] = finalized.recordingIds.map((recordingId, index) => ({
            recordingId,
            filePath: finalized.filePaths[index],
            segmentIndex: index,
          }));
          if (segments.length > 0) {
            await writeSegmentManifest(segments[0].recordingId, segments);
          }
          return { videoFilePaths: finalized.filePaths, videoRecordingIds: finalized.recordingIds };
        }
      );
    }
    if (video.iosRecordingId) {
      const recordingId = video.iosRecordingId;
      return this.finalizeWithFallback(
        `Stopping automatic video recording: ${recordingId}`,
        "Failed to stop automatic video recording",
        async () => {
          const stopResult = await this.videoRecorder.stopVideoRecording(recordingId);
          this.perfLog(`Video recording stopped successfully: ${stopResult.metadata.filePath}`);
          return { videoFilePaths: [stopResult.metadata.filePath], videoRecordingIds: [recordingId] };
        }
      );
    }
    return { videoFilePaths: [], videoRecordingIds: [] };
  }

  private async finalizeWithFallback(
    startMessage: string,
    failureMessage: string,
    finalize: () => Promise<FinalizedVideo>
  ): Promise<FinalizedVideo> {
    try {
      this.perfLog(startMessage);
      return await finalize();
    } catch (videoError) {
      logger.warn(`[PERF +${this.timer.now() - this.perfStart}ms] ${failureMessage}: ${videoError}`);
      return { videoFilePaths: [], videoRecordingIds: [] };
    }
  }

  private async recordExecution(
    status: TestExecutionStatus,
    startTime: number,
    options?: {
      steps?: TestStepRecord[];
      errorMessage?: string;
      videoPath?: string;
    }
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
      if (stopped) { return; }
      count++;
      this.progress!(count, undefined, "executing").catch(err => {
        logger.debug(`[executePlan] Progress heartbeat delivery failed: ${err}`);
      });
    }, HEARTBEAT_INTERVAL_MS);
    return () => {
      stopped = true;
      this.timer.clearInterval(handle);
    };
  }
}
