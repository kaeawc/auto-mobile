import { INTERNAL_MCP_SESSION_PARAM } from "../daemon/wire/constants";
import { defaultDaemonContext } from "../daemon/daemonContext";
import type { DevicePool } from "../daemon/devicePool";
import { InputDeviceOwnedError } from "../daemon/inputDeviceOwnership";
import { DeviceOutsideBrokerGrantError } from "../daemon/sessionBroker/connectionRefusal";
import {
  brokerConnectionPlanLabelRefusal,
  grantedDeviceFailsLabelCriteria,
} from "../daemon/sessionBroker/connectionScope";
import { PLAN_LABEL_SESSION_SOURCE, type SessionManager } from "../daemon/sessionManager";
import {
  TestExecutionRepository,
  TestExecutionStatus,
  TestStepRecord,
} from "../db/testExecutionRepository";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { ActionableError, BootedDevice, ExecutePlanResult, PlanExecutionResult } from "../models";
import { PlanExecutionOptions } from "../models/ExecutePlanResult";
import type { Plan } from "../models/Plan";
import { serverConfig, type PlanExecutionLease } from "../utils/ServerConfig";
import { defaultTimer, Timer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { normalizePlanDevices } from "../utils/plan/PlanDevices";
import { PlanPartitioner } from "../utils/plan/PlanPartitioner";
import { PlanSchemaValidator } from "../utils/plan/PlanSchemaValidator";
import { decodePlanYamlContent } from "../utils/plan/planYaml";
import {
  AndroidSegmentedPlanVideoSession,
  type SegmentedSessionResult,
} from "./androidSegmentedPlanVideoSession";
import {
  buildDeviceLabelMap,
  planLifecycleSessionUuid,
  registerDeviceLabelMap,
  requireMultiDeviceDaemon,
} from "./deviceLabelMapping";
import { type PlanHealthWriter } from "./filePlanHealthWriter";
import { daemonPlanDeviceOwnership, type PlanDeviceOwnership } from "./planDeviceOwnership";
import {
  CANCELLED_VIDEO_DISCARD_TIMEOUT_MS,
  CANCELLED_VIDEO_FINALIZE_TIMEOUT_MS,
  type CancelledVideoTeardown,
  convertDebugStepsToRecords,
  convertPerDeviceSkippedStepsToRecords,
  DEFAULT_IOS_VIDEO_MAX_DURATION_SECONDS,
  type ExecutionContext,
  type FinalizedVideo,
  getDeviceType,
  HEARTBEAT_INTERVAL_MS,
  type NormalizedPlanDevices,
  planBaseEndFields,
  planDeviceFailuresField,
  type PlanExecutionDependencies,
  type PlanExecutionRequest,
  planRefusalFields,
  planShutdownInterruptionFields,
  planSkippedStepsField,
  planToolResultsField,
  planToolResultsTruncatedField,
  planWarningsField,
  rethrowDeviceLoss,
  sharedTestExecutionRepository,
  type VideoRecorder,
  type VideoState,
} from "./planExecutionRecords";
import { executePlan, importPlanFromYaml } from "./planExecutorFactory";
import { healthSummaryField, planHealthWriterFromEnv, reportPlanHealth } from "./planHealthSummary";
import { recoverCompletedIosVideo, runShieldedTeardown } from "./planVideoRecovery";
import { type StoppedSegment, writeSegmentManifest } from "./segmentManifest";
import { ProgressCallback } from "./toolRegistry";
import {
  getVideoRecordingMetadata as defaultGetVideoRecordingMetadata,
  getVideoRecordingStatus as defaultGetVideoRecordingStatus,
  rollbackVideoRecordingStart as defaultRollbackVideoRecordingStart,
  startVideoRecording as defaultStartVideoRecording,
  stopVideoRecording as defaultStopVideoRecording,
} from "../daemon/videoRecordingManager";
export {
  convertDebugStepsToRecords,
  planBaseEndFields,
  type PlanExecutionDependencies,
  type PlanExecutionRequest,
  planRefusalFields,
  type VideoRecorder,
} from "./planExecutionRecords";

/**
 * Orchestrates a single executePlan invocation end-to-end.
 *
 * Phases (each is a private method, all tested in isolation):
 *   1. {@link preparePlan} — base64 decode, schema validation, YAML parse, device-list reconcile
 *   2. {@link allocateDevices} — multi-device upfront allocation with shared timeout
 *   3. {@link startVideoRecording} — Android segmented OR iOS single-file recording
 *   4. {@link runPlan} — delegates to executePlan (planExecutorFactory) with the right options
 *   5. {@link finalizeVideo} — stops/finalizes recording (always runs in finally)
 *   6. {@link recordExecution} — writes a row to the test-execution timing DB
 *
 * The progress heartbeat (keeps SSE stream alive during long plans) and the
 * top-level try/catch (so the tool always returns a structured response, never
 * throws) wrap the whole sequence in {@link execute}.
 */
export class PlanExecutionOrchestrator {
  // Capture before planTools installs this invocation's own planRequest context.
  private readonly nestedInPlan = getToolSelectionContext()?.planRequest !== undefined;
  private readonly device: BootedDevice;
  private readonly request: PlanExecutionRequest;
  private readonly progress?: ProgressCallback;
  private readonly signal?: AbortSignal;
  private readonly timer: Timer;
  private readonly testExecutionRepository: Pick<TestExecutionRepository, "recordExecution">;
  private readonly createSchemaValidator: () => Pick<
    PlanSchemaValidator,
    "loadSchema" | "validateYaml"
  >;
  private readonly videoRecorder: VideoRecorder;
  private readonly deviceOwnership: PlanDeviceOwnership;
  private readonly healthWriter?: PlanHealthWriter;

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
    this.healthWriter = deps.healthWriter ?? planHealthWriterFromEnv(this.timer);
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

  private registerPlanExecution(): PlanExecutionLease {
    const context = getToolSelectionContext();
    const labelSessionUuids = this.request.sessionUuid
      ? Object.values(
          buildDeviceLabelMap(
            this.effectiveLabels(),
            this.request.sessionUuid,
            this.request.device,
          ),
        )
      : [];
    return serverConfig.acquirePlanExecutionLease({
      sessionUuid: this.request.sessionUuid ?? context?.routingSessionUuid,
      deviceId: this.device.deviceId,
      executionId: context?.execution?.executionId,
      // The label sessions allocateDevices() will publish, named before its first await (#14444).
      labelSessionUuids,
    });
  }

  /** The labels this invocation allocates: the request's `devices`, else the plan's own. */
  private effectiveLabels(): string[] {
    return this.request.devices && this.request.devices.length > 0
      ? this.request.devices
      : (this.normalizedDevices ?? normalizePlanDevices()).labels;
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

      // Register before allocation so current session/label assignments are
      // protected even before adb binds the execution. Unassigned booting devices
      // use Android startup leases and ordinary discovery/debounce protection;
      // this lease does not globally defer their cleanup. Always release it,
      // including allocation or video startup failures.
      const planExecutionLease = this.registerPlanExecution();

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

      const healthSummary = await reportPlanHealth(
        this.healthWriter,
        result,
        this.timer.now() - startTime,
      );

      const response: ExecutePlanResult = {
        success: result.success,
        ...healthSummaryField(healthSummary),
        executedSteps: result.executedSteps,
        totalSteps: result.totalSteps,
        failedStep: result.failedStep,
        error: result.failedStep ? result.failedStep.error : undefined,
        ...planBaseEndFields(this.request.sessionUuid, result.success, result.failedStep),
        ...planShutdownInterruptionFields(this.signal, result.success),
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
        ...planToolResultsField(result.toolResults),
        ...planToolResultsTruncatedField(result.toolResultsTruncated),
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

      const failureHealth = await reportPlanHealth(
        this.healthWriter,
        undefined,
        this.timer.now() - startTime,
      );
      const response: ExecutePlanResult = {
        success: false,
        executedSteps: 0,
        totalSteps: 0,
        error: `${error}`,
        ...planRefusalFields(error),
        ...planShutdownInterruptionFields(this.signal),
        platform: this.device.platform,
        deviceId: this.device.deviceId,
        ...healthSummaryField(failureHealth),
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
      yamlContent = decodePlanYamlContent(yamlContent);
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
    const plan = importPlanFromYaml(yamlContent, { platform: this.request.platform });
    this.perfLog(`Plan parsed: '${plan.name}' with ${plan.steps.length} steps`);

    this.normalizedDevices = normalizePlanDevices(plan.devices);
    if (
      this.nestedInPlan &&
      (this.request.devices?.length || this.request.device || this.normalizedDevices.labels.length)
    ) {
      throw new ActionableError(
        "Nested executePlan cannot use devices/device labels. Remove the labels; nested plans run on the enclosing plan's session/device.",
      );
    }
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
    const effectiveLabels = this.effectiveLabels();

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

    const { devicePool, sessionManager } = requireMultiDeviceDaemon();
    const labelToSessionMap = buildDeviceLabelMap(
      effectiveLabels,
      sessionUuid,
      this.request.device,
    );
    const sessionIds = Object.values(labelToSessionMap);
    // A managed connection is refused here, before anything is published, allocated or booted.
    const grantedDevices = this.brokerGrantedLabelDevices(
      sessionUuid,
      labelToSessionMap,
      normalized,
      sessionManager,
    );
    this.refuseLabelNamingSessionOfItsOwn(
      sessionUuid,
      labelToSessionMap,
      sessionManager,
      grantedDevices,
    );

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

    // A derived label session lives only as long as its plan run (#11572): this run's allocation
    // may mint each label again, however the previous run's label session ended. A broker binding
    // serves its labels with live binding sessions and mints nothing.
    const allocation = Promise.resolve().then(() => {
      if (grantedDevices) {
        return grantedDevices;
      }
      const closeLabelMints = sessionManager.openPlanLabelMints(sessionUuid, labelToSessionMap);
      return Promise.resolve()
        .then(() =>
          this.requestDeviceAllocation(
            devicePool,
            normalized,
            effectiveLabels,
            labelToSessionMap,
            sessionIds,
          ),
        )
        .finally(closeLabelMints);
    });

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

  /**
   * A plan never takes a session it did not mint as one of its labels (#11602). A live
   * `${base}:${label}` session that no plan run minted is a session of its own, created under a
   * caller-chosen id before this base existed: publishing it as a label would hand its device to
   * the base's owner and refuse its own connection. Refused typed before anything is published
   * or allocated; the plan runs once that session is released or the label is renamed.
   */
  private refuseLabelNamingSessionOfItsOwn(
    sessionUuid: string,
    labelToSessionMap: Record<string, string>,
    sessionManager: SessionManager,
    grantedDevices: Map<string, string> | undefined,
  ): void {
    // A broker binding serves its labels with its own live binding sessions and mints nothing.
    if (grantedDevices) {
      return;
    }
    for (const [label, labelSessionUuid] of Object.entries(labelToSessionMap)) {
      const taken =
        labelSessionUuid === sessionUuid ? null : sessionManager.peekSession(labelSessionUuid);
      if (taken && taken.persistenceMetadata?.source !== PLAN_LABEL_SESSION_SOURCE) {
        throw new InputDeviceOwnedError(
          "executePlan",
          taken.assignedDevice,
          sessionUuid,
          undefined,
          `executePlan refused: device label '${label}' would be session ${labelSessionUuid}, ` +
            "which is already a live session that no plan run created. " +
            "Release that session or rename the label, then run the plan again.",
        );
      }
    }
  }

  /**
   * Broker bindings (#11397): a managed connection controls only its own binding devices, so its plan
   * labels are never handed to the generic pool allocator, which lends generic devices and can boot
   * more. Returns the session -> device map for labels its own binding sessions serve, throws
   * `device_outside_broker_grant` for a label they cannot serve, and returns undefined for a
   * generic connection. A plan step carries no socket session id, so the connection is also
   * recognized by the binding session the plan runs on.
   */
  private brokerGrantedLabelDevices(
    sessionUuid: string,
    labelToSessionMap: Record<string, string>,
    normalized: NormalizedPlanDevices,
    sessionManager: SessionManager,
  ): Map<string, string> | undefined {
    const scopes = defaultDaemonContext.brokerConnectionScopes();
    const devicePool = defaultDaemonContext.devicePool();
    if (!scopes || !devicePool) {
      return undefined;
    }
    const connectionId: unknown = Reflect.get(this.request, INTERNAL_MCP_SESSION_PARAM);
    const binding =
      scopes.get(typeof connectionId === "string" ? connectionId : undefined) ??
      scopes.forGrantedSession(planLifecycleSessionUuid(sessionUuid));
    if (!binding) {
      return undefined;
    }
    const refusal = brokerConnectionPlanLabelRefusal({
      binding,
      action: "executePlan",
      labelSessions: labelToSessionMap,
    });
    if (refusal) {
      throw refusal;
    }
    const grantedDevices = new Map<string, string>();
    for (const [label, grantedSessionUuid] of Object.entries(labelToSessionMap)) {
      const grantedSession = sessionManager.getSession(grantedSessionUuid);
      // The broker grant serves the label with its own device or not at all: a declared criterion that
      // device demonstrably fails is refused instead of silently ignored (#11421).
      if (
        !grantedSession?.assignedDevice ||
        grantedDeviceFailsLabelCriteria({
          declared: normalized.definitions.find((definition) => definition.label === label),
          grantedPlatform: grantedSession.platform,
          device: devicePool.getDevice(grantedSession.assignedDevice),
        })
      ) {
        throw new DeviceOutsideBrokerGrantError("executePlan", "tool", binding.scopeKey, {
          deviceLabel: label,
        });
      }
      grantedDevices.set(grantedSessionUuid, grantedSession.assignedDevice);
    }
    return grantedDevices;
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
        // be raced by several tracks.
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
  private async runShieldedTeardown(teardown: CancelledVideoTeardown): Promise<FinalizedVideo> {
    return runShieldedTeardown({ timer: this.timer }, teardown);
  }

  private async recoverCompletedIosVideo(
    recordingId: string,
    planEndMs: number,
  ): Promise<FinalizedVideo | undefined> {
    return recoverCompletedIosVideo({ videoRecorder: this.videoRecorder }, recordingId, planEndMs);
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
