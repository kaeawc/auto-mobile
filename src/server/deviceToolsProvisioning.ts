import { provisionCancellationOutcomes } from "./provisionCancellationOutcomes";
import {
  DEVICE_CLEANUP_IN_PROGRESS_CODE,
  DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
  DEVICE_SHUTTING_DOWN_CODE,
  DeviceOwnedByOtherDaemonError,
  SESSION_CREATION_TIMEOUT_CODE,
  RetryableDeviceAcquisitionError,
} from "../daemon/deviceAcquisitionRefusals";
import { InputDeviceOwnedError } from "../daemon/inputDeviceOwnership";
import { captureAutolockPolicy, runWithAutolockPolicy } from "../daemon/deviceAutolockPolicy";
import { observeConfiguredDeviceResources } from "./deviceResourceTools";
import { computeDeviceResourceDrift } from "../utils/deviceResourceDrift";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";
import { errorMessage } from "../utils/describeUnknownError";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { ProgressCallback } from "./toolRegistry";
import type { DeviceResourceConfigurationResult } from "../models/DeviceResourceConfiguration";
import { PlatformDeviceManager } from "../devices/deviceUtils";
import { BootedDevice, DeviceInfo } from "../models";
import { DeviceLostError } from "../models/DeviceLostError";
import { describeDevice, projectProvisionedDevice } from "./deviceDescription";
import { logger } from "../utils/logger";
import { createPerformanceTracker } from "../utils/PerformanceTracker";
import { ambientPerfFor, runWithPerfTracker } from "../utils/PerfContext";
import { DEVICE_POOL_MATCHING } from "../daemon/poolConfig";
import { formatToolParamError } from "./toolParamError";
import { type DeviceCreationGate } from "../devices/deviceCreationGate";
import { DaemonState } from "../daemon/daemonState";
import { reconcileDiscoveryObservation } from "../daemon/discoveryReconcile";
import { isUnresolvedAndroidEmulatorName } from "../devices/deviceIdentityEvidence";
import type { DeviceReadinessLevel } from "../devices/DeviceSessionManager";
import type { DeviceReadinessReservation } from "../daemon/devicePool";
import { McpSessionRecoveryInProgressError } from "../daemon/devicePool";
import {
  buildProvisionDeviceRecoveryEvidence,
  type ProvisionDeviceFailureBoundary,
  type ProvisionDeviceRecoveryEvidence,
  type ProvisionDeviceRecoveryInput,
} from "./provisionDeviceRecoveryEvidence";
import { getCurrentBuildIdentity } from "../daemon/buildIdentity";
import { DAEMON_VERSION } from "../daemon/constants";
import { DaemonHandoffInterruptionError } from "../daemon/daemonHandoffInterruption";
import {
  DeviceBootService,
  DeviceBootTimeoutError,
  type DeviceBootResult,
} from "../devices/deviceBootService";
import { type Timer } from "../utils/SystemTimer";
import { combineAbortSignals } from "../utils/AbortContext";
import { AdbDeviceOfflineError } from "../utils/android-cmdline-tools/AdbDeviceHealth";
import { RunnerReadinessError } from "../ctrlProxy/RunnerReadinessService";
import {
  deviceReadinessLockKey,
  trackDeviceAcquisitionReadiness,
} from "../utils/deviceReadinessLock";
import { serverConfig } from "../utils/ServerConfig";
import {
  DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
  START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
} from "../utils/deviceTimeouts";
import {
  type ExactDeviceProvisioner,
  ProvisionDeviceCreateRejectedError,
  type ProvisionDeviceFailureCode,
  ProvisionDeviceError,
} from "../devices/exactDeviceProvisioning";
import type { ProvisionDeviceLifecycleOutcome } from "../devices/provisionDeviceLifecycle";
import { type VirtualDeviceLifecycleLease } from "../devices/virtualDeviceLifecycleCoordinator";
import { DeviceTeardownService } from "../devices/deviceTeardownService";
import { getProvisionedDeviceTransportFence } from "../utils/provisionedDeviceTransportFence";
import { classifyDisplayCutout } from "../utils/displayCutout";
import {
  type ActiveProvisionDeviceRequest,
  activeProvisionDeviceRequests,
  attachProvisionDeviceLifecycle,
  cancelProvisionDeviceRequest,
  cancelUnownedColdBoot,
  clearColdBootShutdownMarker,
  createProvisionDeviceResponse,
  createToolErrorResponse,
  findExactProvisionedBootedDevice,
  getDeviceToolsDependencies,
  initializedDevicePool,
  isProvisionDeviceCallerAbort,
  isTeardownFailure,
  knownProvisionDeviceError,
  lifecycleCleanupStatus,
  lifecycleForProvisionResponseError,
  lifecycleStateForCleanup,
  parseProvisionDeviceArgs,
  PROVISION_DEVICE_SETTLEMENT_WAIT_MS,
  ProvisionDeviceCleanup,
  provisionDeviceDeadlineMs,
  provisionDeviceSchema,
  ProvisionDeviceRollbackError,
  publishWarmDeviceReady,
  RecordProvisionDeviceLifecycle,
  reserveStableDeviceLifecycle,
  rethrowDeviceLifecycleReservationFailure,
  runOperationWithinDeadline,
  runProvisionDeviceWithinDeadline,
  StableDeviceTarget,
  TeardownDeviceArgs,
  TeardownToolResponse,
  validatePooledDeviceMapping,
  waitForProvisionDeviceSettlement,
  waitForProvisionDeviceRequest,
} from "./deviceTools";
import type { DeviceToolsDependencies, ProvisionDeviceArgs, StartDeviceArgs } from "./deviceTools";
import type { HostChildProcess as ChildProcess } from "../utils/HostCommandExecutor";
import type { RunnerReadinessRequest } from "../ctrlProxy/RunnerReadinessService";

type ProvisioningHooks = {
  bindBootedDeviceSession: (
    device: BootedDevice,
    args: StartDeviceArgs,
    sourceImage?: DeviceInfo,
    childProcess?: ChildProcess | null,
    options?: {
      autolockEnabled?: boolean;
      readinessReservationOwners?: ReadonlySet<symbol>;
      verifiedAndroidAvdIdentity?: DeviceInfo;
      achievedReadiness?: DeviceReadinessLevel;
      collectCancellationSettlement?: (settlement: Promise<void>) => void;
    },
  ) => Promise<string>;
  ensureCtrlProxyReady: (request: RunnerReadinessRequest) => Promise<void>;
  executeDeleteDevice: (
    args: TeardownDeviceArgs,
    deps: DeviceToolsDependencies,
    callerSignal: AbortSignal | undefined,
    teardownService: DeviceTeardownService,
    lifecycleLease?: VirtualDeviceLifecycleLease,
  ) => Promise<TeardownToolResponse>;
};

type ProvisionCleanupOptions = {
  lifecycleLease: VirtualDeviceLifecycleLease | undefined;
  pendingMutationSettlement?: Promise<unknown>;
  /** Absolute rollback deadline already anchored by the caller (e.g. iOS identity discovery). */
  rollbackDeadlineMs?: number;
  recordLifecycle?: RecordProvisionDeviceLifecycle;
  lifecycleDevice?: NonNullable<ProvisionDeviceLifecycleOutcome["device"]>;
};

/** Where a failed provision's rollback should aim; `unresolved` never means absent. */
type ProvisionRollbackTarget =
  | { kind: "device"; device: DeviceInfo }
  | { kind: "absent" }
  | { kind: "unresolved" };

type ProvisionBootOptions = {
  provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>;
  perf: ReturnType<typeof createPerformanceTracker>;
  totalDeadlineMs: number;
  lifecycleLease: VirtualDeviceLifecycleLease;
  signal: AbortSignal | undefined;
  settlementState: ProvisionSettlementState;
  onBooted: (device: BootedDevice) => void;
};

type ProvisionSettlementState = {
  exactProvisioning?: Promise<unknown>;
  unownedColdBootSettlement?: Promise<void>;
  bindingSettlements: Promise<unknown>[];
  readinessReservation?: DeviceReadinessReservation;
};

type ProvisionBootResult = {
  device: BootedDevice;
  sessionId: string;
  source: "booted" | "cold-boot";
  sourceImage?: DeviceInfo;
  resources?: DeviceResourceConfigurationResult;
};

function retryableAcquisitionProvisionCode(code: string): ProvisionDeviceFailureCode | undefined {
  switch (code) {
    case DEVICE_OWNED_BY_OTHER_DAEMON_CODE:
    case DEVICE_CLEANUP_IN_PROGRESS_CODE:
    case SESSION_CREATION_TIMEOUT_CODE:
    case DEVICE_SHUTTING_DOWN_CODE:
      return code;
    default:
      return undefined;
  }
}

/**
 * Typed retryable refusals from the shared bind path keep their wire code and wait hint so a
 * controller retries them the way startDevice/getAndroid clients do.
 */
function retryableAcquisitionProvisionError(
  args: ProvisionDeviceArgs,
  error: unknown,
): ProvisionDeviceError | undefined {
  if (!(error instanceof RetryableDeviceAcquisitionError)) {
    return undefined;
  }
  const code = retryableAcquisitionProvisionCode(error.code);
  if (!code) {
    return undefined;
  }
  return new ProvisionDeviceError(
    code,
    `Failed to provision ${args.device.platform} device '${args.device.name}': ${error.message}`,
    true,
    {
      deviceId: error.deviceId,
      retryAfterMs: error.retryAfterMs,
      ...(error instanceof DeviceOwnedByOtherDaemonError && error.ownerPid !== undefined
        ? { ownerPid: error.ownerPid }
        : {}),
    },
  );
}

export function createProvisionDeviceHandler(hooks: ProvisioningHooks) {
  const { bindBootedDeviceSession, ensureCtrlProxyReady, executeDeleteDevice } = hooks;
  const provisionDeviceHandler = async (
    input: ProvisionDeviceArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    let args: ProvisionDeviceArgs;
    try {
      args = parseProvisionDeviceArgs(input);
    } catch (error) {
      // The MCP boundary already validated the caller's arguments; a failure
      // here means the re-parse rejected something the boundary let through
      // (an internal param, or a genuinely malformed public argument on a
      // non-MCP call path). Either way the caller gets a structured, coded
      // error instead of a raw ZodError escaping the tool.
      const message = `Invalid parameters for tool provisionDevice: ${formatToolParamError(
        "provisionDevice",
        error,
        input,
        provisionDeviceSchema,
      )}`;
      logger.warn(`[DeviceTools] ${message}`, error);
      return createToolErrorResponse("invalid_arguments", message);
    }
    // Every call runs its own lifecycle (#11065). A concurrent request for the
    // same exact device waits on the device lifecycle lease and then adopts the
    // device or is refused by session ownership; nothing is replayed.
    const controller = new AbortController();
    const lifecycleEvidence: ActiveProvisionDeviceRequest["lifecycleEvidence"] = {};
    const promise = executeProvisionDevice(args, controller.signal, lifecycleEvidence);
    const request: ActiveProvisionDeviceRequest = { promise, controller, lifecycleEvidence };
    activeProvisionDeviceRequests.add(request);
    const retire = (): void => {
      activeProvisionDeviceRequests.delete(request);
    };
    void promise.then(retire, retire);
    return await awaitProvisionDeviceRequest(args, request, signal);
  };

  function describeProvisionRequest(args: ProvisionDeviceArgs): string {
    return `${args.device.platform} '${args.device.name}'`;
  }

  async function awaitProvisionDeviceRequest(
    args: ProvisionDeviceArgs,
    request: ActiveProvisionDeviceRequest,
    signal: AbortSignal | undefined,
  ) {
    try {
      const result = await waitForProvisionDeviceRequest(request.promise, signal);
      return createProvisionDeviceResponse(result);
    } catch (error) {
      if (error instanceof DaemonHandoffInterruptionError) {
        if (cancelProvisionDeviceRequest(request, error)) {
          // Let the cancelled lifecycle unwind (rollback, lease release) so the
          // recovery evidence reports what it left behind.
          await request.promise.catch((error) => {
            // Handoff already reports interruption; this wait only lets rollback settle.
            logger.debug(`Provision handoff settlement rejected: ${errorMessage(error)}`);
          });
        }
        logger.warn(
          `[DeviceTools] provisionDevice ${describeProvisionRequest(args)} interrupted by daemon handoff: ${errorMessage(error)}`,
          error,
        );
        return provisionDeviceErrorResponse(
          error,
          provisionDeviceRecovery("daemon_handoff", request, {
            originalError: { code: error.code, message: error.message },
          }),
        );
      }
      if (isProvisionDeviceCallerAbort(error, signal)) {
        cancelProvisionDeviceRequest(request, error);
        const settled = await waitForProvisionDeviceSettlement(
          request.promise,
          getDeviceToolsDependencies().timer,
          PROVISION_DEVICE_SETTLEMENT_WAIT_MS,
        );
        if (!settled) {
          logger.warn(
            `[DeviceTools] provisionDevice ${describeProvisionRequest(args)} caller cancellation stopped waiting for its lifecycle to settle.`,
          );
        }
        // The caller went away, which is not a provisioning failure: report it
        // with a code of its own. The lifecycle is cancelled with its caller.
        logger.warn(
          `[DeviceTools] provisionDevice ${describeProvisionRequest(args)} caller cancelled the request: ` +
            `${errorMessage(error)}`,
          error,
        );
        const cancelledResponse = createToolErrorResponse(
          "request_cancelled",
          "provisionDevice request was cancelled by the caller; its provisioning work was cancelled too.",
          {
            recovery: provisionDeviceRecovery("caller_cancellation", request, {
              settled,
              retryAfterMs: PROVISION_DEVICE_SETTLEMENT_WAIT_MS,
            }),
          },
        );
        // The daemon answered the abandoned request already; hand it this result so that reply
        // can carry the typed envelope and recovery evidence.
        if (args.__mcpLiveDeadlineKey) {
          provisionCancellationOutcomes.publish(args.__mcpLiveDeadlineKey, cancelledResponse);
        }
        return cancelledResponse;
      }
      logger.warn(
        `[DeviceTools] provisionDevice ${describeProvisionRequest(args)} failed: ${errorMessage(error)}`,
        error,
      );
      return provisionDeviceErrorResponse(error, failureBoundaryRecovery(error, request));
    }
  }

  /** Readiness and cleanup failures carry the same evidence envelope as the other boundaries. */
  function failureBoundaryRecovery(
    error: unknown,
    request: ActiveProvisionDeviceRequest,
  ): ProvisionDeviceRecoveryEvidence | undefined {
    if (recoveryFromError(error)) {
      return undefined;
    }
    const lifecycle = lifecycleForProvisionResponseError(error);
    const boundary = failureBoundaryFor(error, lifecycle);
    if (!boundary) {
      return undefined;
    }
    const failure = error instanceof ProvisionDeviceRollbackError ? error.provisionFailure : error;
    const { code, retryable } = failureCodeAndRetryability(failure);
    const { ownership } = request.lifecycleEvidence;
    return buildProvisionDeviceRecoveryEvidence({
      boundary,
      nowMs: getDeviceToolsDependencies().timer.now(),
      daemonBuild: `${DAEMON_VERSION}+${getCurrentBuildIdentity().buildId}`,
      // A rollback error's own lifecycle is newer than the last one recorded.
      lifecycle: lifecycle ?? request.lifecycleEvidence.lifecycle,
      ...(ownership ? { ownership } : {}),
      originalError: { code, message: errorMessage(failure) },
      ...(retryable !== undefined ? { retryable } : {}),
    });
  }

  function failureCodeAndRetryability(failure: unknown): { code: string; retryable?: boolean } {
    if (failure instanceof ProvisionDeviceError) {
      return { code: failure.code, retryable: failure.retryable };
    }
    return { code: "platform_command_failed" };
  }

  function failureBoundaryFor(
    error: unknown,
    lifecycle: ProvisionDeviceLifecycleOutcome | undefined,
  ): ProvisionDeviceFailureBoundary | undefined {
    if (error instanceof ProvisionDeviceRollbackError && error.cleanup.status !== "succeeded") {
      return "cleanup_failure";
    }
    // A rollback that removed the device is a provisioning failure with a clean
    // cleanup, so it is classified by the failure that triggered it.
    const readiness =
      (error instanceof ProvisionDeviceError && error.diagnostics.readinessPhase) ||
      lifecycle?.reason?.readinessPhase ||
      lifecycle?.phase === "readiness";
    if (readiness || error instanceof ProvisionDeviceRollbackError) {
      return "readiness_failure";
    }
    return undefined;
  }

  function provisionDeviceRecovery(
    boundary: ProvisionDeviceFailureBoundary,
    request: ActiveProvisionDeviceRequest,
    extra: Pick<ProvisionDeviceRecoveryInput, "settled" | "originalError" | "retryAfterMs">,
  ): ProvisionDeviceRecoveryEvidence {
    return buildProvisionDeviceRecoveryEvidence({
      boundary,
      nowMs: getDeviceToolsDependencies().timer.now(),
      daemonBuild: `${DAEMON_VERSION}+${getCurrentBuildIdentity().buildId}`,
      lifecycle: request.lifecycleEvidence.lifecycle,
      ...(request.lifecycleEvidence.ownership
        ? { ownership: request.lifecycleEvidence.ownership }
        : {}),
      ...extra,
    });
  }

  async function executeProvisionDevice(
    args: ProvisionDeviceArgs,
    signal: AbortSignal | undefined,
    lifecycleEvidence: ActiveProvisionDeviceRequest["lifecycleEvidence"],
  ): Promise<Record<string, unknown>> {
    const deps = getDeviceToolsDependencies();
    const recordLifecycle: RecordProvisionDeviceLifecycle = (lifecycle) => {
      lifecycleEvidence.lifecycle = lifecycle;
      if (lifecycle.phase === "created" || lifecycle.phase === "adopted") {
        lifecycleEvidence.ownership =
          lifecycle.phase === "created" ? "created_by_request" : "adopted";
      }
    };
    // ONE absolute deadline for the whole request, anchored here and sliced
    // across every phase below (lifecycle lease wait, provisioning, boot,
    // readiness), clamped so rollback still fits inside the daemon's queued
    // request deadline (the `reserveRollbackTime` form).
    const totalDeadlineMs = provisionDeviceDeadlineMs(args, deps.timer, true);
    try {
      return await runProvisionDeviceLifecycle(args, deps, {
        recordLifecycle,
        totalDeadlineMs,
        signal,
      });
    } catch (error) {
      if (
        error instanceof McpSessionRecoveryInProgressError ||
        error instanceof DaemonHandoffInterruptionError
      ) {
        // Transient by construction: the device stays viable and a retry
        // re-runs the lifecycle, adopting it under the lifecycle lease.
        logger.warn(
          `[DeviceTools] provisionDevice ${describeProvisionRequest(args)} interrupted: ${errorMessage(error)}`,
          error,
        );
        throw error;
      }
      throw toProvisionDeviceError(args, error);
    }
  }

  function toProvisionDeviceError(args: ProvisionDeviceArgs, error: unknown): ProvisionDeviceError {
    const knownError = knownProvisionDeviceError(error);
    if (knownError) {
      return knownError;
    }
    if (error instanceof InputDeviceOwnedError) {
      return new ProvisionDeviceError(
        "device_owned_by_other_session",
        `Failed to provision ${args.device.platform} device '${args.device.name}': ${error.message}`,
        true,
        { deviceId: error.deviceId },
      );
    }
    const acquisitionFailure = retryableAcquisitionProvisionError(args, error);
    if (acquisitionFailure) {
      return acquisitionFailure;
    }
    if (error instanceof RunnerReadinessError) {
      const cause = error.diagnosticCause;
      if (cause instanceof DeviceLostError) {
        return new ProvisionDeviceError(
          "device_lost",
          `Failed to provision ${args.device.platform} device '${args.device.name}': ${error.message}`,
          true,
          {
            providerCode: cause.code,
            readinessPhase: error.phase,
            attempt: error.attempts,
            incidentId: cause.incidentId,
            deviceId: cause.deviceId,
          },
        );
      }
      if (cause instanceof AdbDeviceOfflineError) {
        return new ProvisionDeviceError(
          "device_offline",
          `Failed to provision ${args.device.platform} device '${args.device.name}': ${error.message}`,
          true,
          {
            providerCode: cause.code,
            readinessPhase: error.phase,
            attempt: error.attempts,
            deviceId: cause.deviceId,
          },
        );
      }
    }
    // A readiness phase that ran out of budget is a purely time-based failure:
    // report it as `timeout` so a controller that retries timeouts but treats
    // `platform_command_failed` as terminal does not give up on it.
    const isDeadlineFailure =
      error instanceof DeviceBootTimeoutError ||
      (error instanceof RunnerReadinessError && error.deadlineExhausted);
    return new ProvisionDeviceError(
      isDeadlineFailure ? "timeout" : "platform_command_failed",
      `Failed to provision ${args.device.platform} device '${args.device.name}': ${errorMessage(error)}`,
    );
  }

  function provisionDeviceLifecycleReason(error: ProvisionDeviceError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...provisionDeviceDiagnosticFields(error),
    };
  }

  function teardownResponsePayload(
    response: TeardownToolResponse,
  ): Record<string, unknown> | undefined {
    const text = response.content.find((content) => content.type === "text")?.text;
    if (!text) {
      return undefined;
    }
    try {
      const payload: unknown = JSON.parse(text);
      return typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : undefined;
    } catch (error) {
      logger.warn(`[DeviceTools] Failed to decode internal teardown response: ${error}`, error);
      return undefined;
    }
  }

  function provisionDeviceCleanupResult(
    cleanupArgs: TeardownDeviceArgs,
    response: TeardownToolResponse,
  ): ProvisionDeviceCleanup {
    const payload = teardownResponsePayload(response);
    const failure = payload?.failure;
    if (
      isTeardownFailure(response) &&
      typeof failure === "object" &&
      failure !== null &&
      !Array.isArray(failure)
    ) {
      const failureRecord = failure as Record<string, unknown>;
      return {
        status: "failed",
        target: cleanupArgs.target,
        failure: {
          code: typeof failureRecord.code === "string" ? failureRecord.code : "operation_failed",
          phase: typeof failureRecord.phase === "string" ? failureRecord.phase : "verification",
          message:
            typeof failureRecord.message === "string"
              ? failureRecord.message
              : "Device cleanup failed without a diagnostic.",
        },
      };
    }
    if (isTeardownFailure(response)) {
      return {
        status: "failed",
        target: cleanupArgs.target,
        failure: {
          code: "operation_failed",
          phase: "verification",
          message: "Device cleanup failed without a structured diagnostic.",
        },
      };
    }
    return {
      status: "succeeded",
      target: cleanupArgs.target,
      state: typeof payload?.state === "string" ? payload.state : "destroyed",
    };
  }

  async function provisionMutationSettledWithinRollbackBudget(
    deps: DeviceToolsDependencies,
    settlement: Promise<unknown>,
    rollbackDeadlineMs: number,
  ): Promise<boolean> {
    const remainingMs = Math.floor(rollbackDeadlineMs - deps.timer.now());
    if (remainingMs <= 0) {
      return false;
    }
    const deadline = new Error("Provision rollback settlement wait timed out");
    try {
      return await raceWithDeadline(
        settlement.then(
          () => true,
          () => true,
        ),
        {
          timer: deps.timer,
          timeoutMs: remainingMs,
          label: "Provision rollback settlement",
          timeoutError: () => deadline,
        },
      );
    } catch (error) {
      if (error === deadline) {
        return false;
      }
      throw error;
    }
  }

  function retainProvisionLifecycleUntilMutationSettles(
    lifecycleLease: VirtualDeviceLifecycleLease,
    settlement: Promise<unknown>,
    stableId: string,
  ): void {
    void settlement
      .finally(() => lifecycleLease.release())
      .catch((error: unknown) => {
        logger.warn(
          `[DeviceTools] Deferred provision mutation for '${stableId}' rejected before lifecycle ownership was released: ${errorMessage(error)}`,
          error,
        );
      });
  }

  function retainPendingProvisionMutationLifecycle(
    args: ProvisionDeviceArgs,
    provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>> | undefined,
    takeLifecycleLease: () => VirtualDeviceLifecycleLease | undefined,
    pendingMutationSettlement: Promise<unknown> | undefined,
  ): void {
    if (!pendingMutationSettlement) {
      return;
    }
    const lifecycleLease = takeLifecycleLease();
    if (!lifecycleLease) {
      return;
    }
    const stableId =
      provisioned?.device.platform === "ios"
        ? (provisioned.device.deviceId ?? args.device.name)
        : args.device.name;
    retainProvisionLifecycleUntilMutationSettles(
      lifecycleLease,
      pendingMutationSettlement,
      stableId,
    );
  }

  function continueProvisionCleanupAfterMutationSettles(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    createdDevice: DeviceInfo,
    provisionFailure: ProvisionDeviceError,
    {
      lifecycleLease,
      settlement,
      recordLifecycle,
      lifecycleDevice,
    }: {
      lifecycleLease: VirtualDeviceLifecycleLease;
      settlement: Promise<unknown>;
      recordLifecycle?: RecordProvisionDeviceLifecycle;
      lifecycleDevice?: NonNullable<ProvisionDeviceLifecycleOutcome["device"]>;
    },
  ): void {
    const finishCleanup = async (): Promise<void> => {
      const final = await cleanupFailedProvisionDevice(
        args,
        deps,
        createdDevice,
        provisionFailure,
        {
          lifecycleLease: lifecycleLease,
          pendingMutationSettlement: undefined,
          recordLifecycle: recordLifecycle,
          lifecycleDevice: lifecycleDevice,
        },
      );
      if (final.cleanup.status === "failed") {
        logger.warn(
          `[DeviceTools] Deferred provision cleanup for '${createdDevice.name}' failed: ` +
            `${final.cleanup.failure?.message ?? final.message}`,
        );
      }
    };
    void settlement.then(finishCleanup, finishCleanup).catch((error: unknown) => {
      logger.warn(
        `[DeviceTools] Deferred provision cleanup for '${createdDevice.name}' rejected: ${errorMessage(error)}`,
        error,
      );
      lifecycleLease.release();
    });
  }

  function provisionCleanupPreconditionFailure(
    provisionFailure: ProvisionDeviceError,
    cleanupArgs: TeardownDeviceArgs,
    code: string,
    message: string,
  ): ProvisionDeviceRollbackError {
    return new ProvisionDeviceRollbackError(provisionFailure, {
      status: "failed",
      target: cleanupArgs.target,
      failure: { code, phase: "precondition", message },
    });
  }

  function unresolvedProvisionCleanup(
    args: ProvisionDeviceArgs,
    createdDevice: DeviceInfo,
    provisionFailure: ProvisionDeviceError,
  ): ProvisionDeviceRollbackError {
    return new ProvisionDeviceRollbackError(provisionFailure, {
      status: "failed",
      target: {
        platform: createdDevice.platform,
        isVirtual: true,
        stableId: args.device.name,
        stableName: createdDevice.name,
      },
      failure: {
        code: "target_identity_unresolved",
        phase: "precondition",
        message: "The newly created device has no stable identity for cleanup.",
      },
    });
  }

  function provisionCleanupLifecycle(
    rollbackError: ProvisionDeviceRollbackError,
    lifecycleDevice: NonNullable<ProvisionDeviceLifecycleOutcome["device"]>,
    provisionFailure: ProvisionDeviceError,
  ): ProvisionDeviceLifecycleOutcome {
    return {
      state: lifecycleStateForCleanup(rollbackError.cleanup),
      phase: "cleanup",
      device: lifecycleDevice,
      reason: provisionDeviceLifecycleReason(provisionFailure),
      cleanup: {
        status: lifecycleCleanupStatus(rollbackError.cleanup),
        reason: provisionFailure.code === "timeout" ? "readiness_timeout" : "provisioning_failure",
      },
    };
  }

  async function cleanupFailedProvisionDevice(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    createdDevice: DeviceInfo,
    provisionFailure: ProvisionDeviceError,
    {
      lifecycleLease,
      pendingMutationSettlement,
      recordLifecycle,
      lifecycleDevice,
      rollbackDeadlineMs = deps.timer.now() + DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
    }: ProvisionCleanupOptions,
  ): Promise<ProvisionDeviceRollbackError> {
    const stableId =
      createdDevice.platform === "android" ? createdDevice.name : createdDevice.deviceId;
    if (!stableId) {
      return unresolvedProvisionCleanup(args, createdDevice, provisionFailure);
    }
    const cleanupArgs: TeardownDeviceArgs = {
      target: {
        platform: createdDevice.platform,
        isVirtual: true,
        stableId,
        stableName: createdDevice.name,
      },
      mode: "destroy",
      verifyAbsence: true,
      timeoutMs: DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
    };
    const finalizeCleanup = async (
      rollbackError: ProvisionDeviceRollbackError,
    ): Promise<ProvisionDeviceRollbackError> => {
      if (!recordLifecycle || !lifecycleDevice) {
        return rollbackError;
      }
      const lifecycle = provisionCleanupLifecycle(rollbackError, lifecycleDevice, provisionFailure);
      recordLifecycle(lifecycle);
      if (
        lifecycle.state === "removed" &&
        lifecycleDevice.platform === "android" &&
        lifecycleDevice.runtimeDeviceId
      ) {
        await getProvisionedDeviceTransportFence().retire({
          deviceId: lifecycleDevice.runtimeDeviceId,
          stableId: lifecycleDevice.stableId,
          reason: lifecycle.reason?.code ?? "provisioning failure",
        });
      }
      return attachProvisionDeviceLifecycle(rollbackError, lifecycle);
    };
    const cleanupService = new DeviceTeardownService({
      lifecycleCoordinator: deps.lifecycleCoordinator,
      timer: deps.timer,
    });
    let lifecycleLeaseTransferred = false;
    try {
      if (!lifecycleLease) {
        return await finalizeCleanup(
          provisionCleanupPreconditionFailure(
            provisionFailure,
            cleanupArgs,
            "lifecycle_reservation_lost",
            "The provisioning lifecycle reservation was lost before cleanup.",
          ),
        );
      }
      if (
        pendingMutationSettlement &&
        !(await provisionMutationSettledWithinRollbackBudget(
          deps,
          pendingMutationSettlement,
          rollbackDeadlineMs,
        ))
      ) {
        lifecycleLeaseTransferred = true;
        const pendingCleanup = await finalizeCleanup(
          provisionCleanupPreconditionFailure(
            provisionFailure,
            cleanupArgs,
            "mutation_settlement_timeout",
            "Cancelled provisioning mutation did not settle within the rollback budget; " +
              "cleanup was not attempted and lifecycle ownership remains until it settles.",
          ),
        );
        continueProvisionCleanupAfterMutationSettles(args, deps, createdDevice, provisionFailure, {
          lifecycleLease: lifecycleLease,
          settlement: pendingMutationSettlement,
          recordLifecycle: recordLifecycle,
          lifecycleDevice: lifecycleDevice,
        });
        return pendingCleanup;
      }
      const remainingRollbackMs = Math.floor(rollbackDeadlineMs - deps.timer.now());
      if (remainingRollbackMs <= 0) {
        return await finalizeCleanup(
          provisionCleanupPreconditionFailure(
            provisionFailure,
            cleanupArgs,
            "rollback_budget_exhausted",
            "The rollback budget was exhausted before device cleanup could start.",
          ),
        );
      }
      cleanupArgs.timeoutMs = remainingRollbackMs;
      lifecycleLease.transitionToTeardown();
      await lifecycleLease.bindCanonicalIdentity({
        platform: createdDevice.platform,
        stableId,
      });
      const cleanup = executeDeleteDevice(
        cleanupArgs,
        deps,
        undefined,
        cleanupService,
        lifecycleLease,
      );
      lifecycleLeaseTransferred = true;
      const response = await cleanup;
      return await finalizeCleanup(
        new ProvisionDeviceRollbackError(
          provisionFailure,
          provisionDeviceCleanupResult(cleanupArgs, response),
        ),
      );
    } catch (error) {
      // A rollback failure summarizes to a one-line message in the response, so
      // the daemon log is the only forensic record of what actually went wrong.
      logger.warn(
        `[DeviceTools] provisionDevice rollback teardown failed for '${cleanupArgs.target.stableId}': ${errorMessage(error)}`,
        error,
      );
      return await finalizeCleanup(
        new ProvisionDeviceRollbackError(provisionFailure, {
          status: "failed",
          target: cleanupArgs.target,
          failure: {
            code: "lifecycle_reservation_lost",
            phase: "precondition",
            message: errorMessage(error),
          },
        }),
      );
    } finally {
      if (!lifecycleLeaseTransferred) {
        lifecycleLease?.release();
      }
    }
  }

  /**
   * The exact-identity filter shared by iOS lifecycle reservation and rollback:
   * a simulator only matches when its name, runtime and device type all match
   * the request, preferring an available one over an unavailable duplicate.
   */
  function findExactIosProvisionDeviceCandidate(
    args: ProvisionDeviceArgs,
    devices: DeviceInfo[],
  ): DeviceInfo | undefined {
    const spec = args.device.spec;
    if (args.device.deviceId) {
      return devices.find(
        (device) => device.platform === "ios" && device.deviceId === args.device.deviceId,
      );
    }
    const candidates = devices.filter(
      (device) =>
        device.platform === "ios" &&
        device.name === args.device.name &&
        device.deviceId &&
        device.runtime === spec.runtime &&
        device.deviceType === spec.deviceType,
    );
    return candidates.find((device) => device.isAvailable !== false) ?? candidates[0];
  }

  /**
   * Rollback target for an iOS simulator created before provisioning failed.
   * `onBeforeCreate` only fires once the provisioner has established that no
   * matching simulator existed, so a match found now is the one this operation
   * created — the iOS equivalent of Android's name-keyed fallback target.
   *
   * A `simctl create` still in flight can land after a discovery that ran too
   * early, so discovery waits for that mutation to settle first, and both the
   * wait and the discovery are bounded by the rollback deadline. Only a
   * completed discovery that runs after the mutation settled may report
   * `absent`; anything else is `unresolved` (#11064).
   */
  async function resolveCreatedIosProvisionDeviceRollbackTarget(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    deviceManager: PlatformDeviceManager,
    pendingMutationSettlement: Promise<unknown> | undefined,
    rollbackDeadlineMs: number,
  ): Promise<ProvisionRollbackTarget> {
    if (
      pendingMutationSettlement &&
      !(await provisionMutationSettledWithinRollbackBudget(
        deps,
        pendingMutationSettlement,
        rollbackDeadlineMs,
      ))
    ) {
      logger.warn(
        `[DeviceTools] Cannot roll back iOS simulator '${args.device.name}': its creation did not settle within the rollback budget.`,
      );
      return { kind: "unresolved" };
    }
    try {
      const discovery = await runOperationWithinDeadline(
        deps.timer,
        rollbackDeadlineMs,
        undefined,
        () => new Error("iOS rollback identity discovery exceeded the rollback budget"),
        async (deadlineSignal) =>
          await deviceManager.getDeviceImagesDetailed("ios", {
            bypassIosDeviceListCache: true,
            signal: deadlineSignal,
          }),
      );
      if (!discovery.succeededPlatforms.has("ios")) {
        logger.warn(
          `[DeviceTools] Cannot roll back iOS simulator '${args.device.name}': identity discovery did not complete.`,
        );
        return { kind: "unresolved" };
      }
      const device = findExactIosProvisionDeviceCandidate(args, discovery.devices);
      return device ? { kind: "device", device } : { kind: "absent" };
    } catch (error) {
      logger.warn(
        `[DeviceTools] Failed to resolve the iOS rollback target for '${args.device.name}': ${errorMessage(error)}`,
        error,
      );
      return { kind: "unresolved" };
    }
  }

  async function resolveProvisionDeviceRollbackTarget(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    deviceManager: PlatformDeviceManager,
    {
      provisioned,
      creationStarted,
      observedRuntimeDevice,
      pendingMutationSettlement,
      rollbackDeadlineMs,
    }: {
      provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>> | undefined;
      creationStarted: boolean;
      observedRuntimeDevice: BootedDevice | undefined;
      pendingMutationSettlement: Promise<unknown> | undefined;
      rollbackDeadlineMs: number;
    },
  ): Promise<ProvisionRollbackTarget> {
    if (!provisioned?.created && !creationStarted) {
      return { kind: "absent" };
    }
    const target: ProvisionRollbackTarget = provisioned
      ? { kind: "device", device: provisioned.device }
      : args.device.platform === "android"
        ? {
            kind: "device",
            device: { name: args.device.name, platform: "android" as const, isRunning: false },
          }
        : await resolveCreatedIosProvisionDeviceRollbackTarget(
            args,
            deps,
            deviceManager,
            pendingMutationSettlement,
            rollbackDeadlineMs,
          );
    if (target.kind !== "device" || !observedRuntimeDevice?.deviceId) {
      return target;
    }
    return {
      kind: "device",
      device: { ...target.device, deviceId: observedRuntimeDevice.deviceId },
    };
  }

  /**
   * A simulator may exist that this operation created, but its identity is
   * unknown: record it retained with unknown ownership (never
   * `no_device_created`) and keep the lifecycle lease until the creating
   * mutation settles, so no other operation can claim the name underneath it.
   */
  function throwProvisionWithUnresolvedCreatedDevice(
    args: ProvisionDeviceArgs,
    provisionFailure: ProvisionDeviceError,
    {
      provisioned,
      takeLifecycleLease,
      pendingMutationSettlement,
      recordLifecycle,
    }: {
      provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>> | undefined;
      takeLifecycleLease: () => VirtualDeviceLifecycleLease | undefined;
      pendingMutationSettlement: Promise<unknown> | undefined;
      recordLifecycle: RecordProvisionDeviceLifecycle;
    },
  ): never {
    retainPendingProvisionMutationLifecycle(
      args,
      provisioned,
      takeLifecycleLease,
      pendingMutationSettlement,
    );
    const rollbackError = new ProvisionDeviceRollbackError(provisionFailure, {
      status: "failed",
      target: {
        platform: args.device.platform,
        isVirtual: true,
        stableId: args.device.deviceId ?? args.device.name,
        stableName: args.device.name,
      },
      failure: {
        code: "target_identity_unresolved",
        phase: "precondition",
        message:
          "A device may have been created, but its exact identity could not be resolved within the rollback budget; it was not removed.",
      },
    });
    const lifecycle: ProvisionDeviceLifecycleOutcome = {
      state: "retained",
      phase: "cleanup",
      reason: provisionDeviceLifecycleReason(provisionFailure),
      cleanup: {
        status: "failed",
        reason: "target_identity_unresolved",
      },
    };
    recordLifecycle(lifecycle);
    throw attachProvisionDeviceLifecycle(rollbackError, lifecycle);
  }

  function throwProvisionWithoutCreatedDevice(
    provisionFailure: ProvisionDeviceError,
    recordLifecycle: RecordProvisionDeviceLifecycle,
  ): never {
    const lifecycle: ProvisionDeviceLifecycleOutcome = {
      state: "no_device_created",
      phase: "provisioning",
      reason: provisionDeviceLifecycleReason(provisionFailure),
    };
    recordLifecycle(lifecycle);
    throw attachProvisionDeviceLifecycle(provisionFailure, lifecycle);
  }

  async function rethrowFailedProvisionDeviceLifecycle(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    deviceManager: PlatformDeviceManager,
    provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>> | undefined,
    {
      creationStarted,
      takeLifecycleLease,
      error,
      unownedColdBootSettlement,
      pendingMutationSettlement,
      recordLifecycle,
      observedRuntimeDevice,
    }: {
      creationStarted: boolean;
      takeLifecycleLease: () => VirtualDeviceLifecycleLease | undefined;
      error: unknown;
      unownedColdBootSettlement: Promise<void> | undefined;
      pendingMutationSettlement: Promise<unknown> | undefined;
      recordLifecycle: RecordProvisionDeviceLifecycle;
      observedRuntimeDevice: BootedDevice | undefined;
    },
  ): Promise<never> {
    if (
      error instanceof McpSessionRecoveryInProgressError ||
      error instanceof DaemonHandoffInterruptionError
    ) {
      // A transport routing conflict or daemon-generation handoff does not
      // invalidate the viable device, so preserve its identity for a retry
      // instead of wrapping the interruption in destructive rollback. Keep
      // the lease when an exact-provisioning mutation is still live so a
      // replacement daemon cannot recreate this identity underneath it.
      retainPendingProvisionMutationLifecycle(
        args,
        provisioned,
        takeLifecycleLease,
        pendingMutationSettlement,
      );
      throw error;
    }
    const rollbackDeadlineMs = deps.timer.now() + DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS;
    const target = await resolveProvisionDeviceRollbackTarget(args, deps, deviceManager, {
      provisioned,
      // The platform tool reported it created nothing, so the requested name is
      // not this request's to delete — it may be a foreign device (#11100).
      creationStarted: creationStarted && !(error instanceof ProvisionDeviceCreateRejectedError),
      observedRuntimeDevice,
      pendingMutationSettlement,
      rollbackDeadlineMs,
    });
    const provisionFailure = toProvisionDeviceError(args, error);
    if (target.kind === "unresolved") {
      return throwProvisionWithUnresolvedCreatedDevice(args, provisionFailure, {
        provisioned,
        takeLifecycleLease,
        pendingMutationSettlement,
        recordLifecycle,
      });
    }
    if (target.kind === "absent") {
      return throwProvisionWithoutCreatedDevice(provisionFailure, recordLifecycle);
    }
    const createdDevice = target.device;
    // A destructive teardown of this AVD must not race the emulator process the
    // failed attempt is still killing.
    await unownedColdBootSettlement;
    const lifecycleDevice = provisionDeviceLifecycleIdentity(
      args,
      createdDevice,
      observedRuntimeDevice,
    );
    recordLifecycle({
      state: "cleanup_in_progress",
      phase: "cleanup",
      device: lifecycleDevice,
      reason: provisionDeviceLifecycleReason(provisionFailure),
      cleanup: { status: "in_progress", reason: "readiness_timeout" },
    });
    throw await cleanupFailedProvisionDevice(args, deps, createdDevice, provisionFailure, {
      lifecycleLease: takeLifecycleLease(),
      pendingMutationSettlement: pendingMutationSettlement,
      recordLifecycle: recordLifecycle,
      lifecycleDevice: lifecycleDevice,
      rollbackDeadlineMs: rollbackDeadlineMs,
    });
  }

  async function reserveExistingIosProvisionDeviceLifecycle(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    deviceManager: PlatformDeviceManager,
    totalDeadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<VirtualDeviceLifecycleLease | undefined> {
    const discovery = await runProvisionDeviceWithinDeadline(
      deps.timer,
      totalDeadlineMs,
      signal,
      "resolving the exact iOS simulator identity",
      async (deadlineSignal) =>
        await deviceManager.getDeviceImagesDetailed("ios", {
          bypassIosDeviceListCache: true,
          signal: deadlineSignal,
        }),
    );
    if (!discovery.succeededPlatforms.has("ios")) {
      throw new ProvisionDeviceError(
        "platform_command_failed",
        `Cannot provision iOS device '${args.device.name}' because simulator identity discovery did not complete.`,
      );
    }
    const existing = findExactIosProvisionDeviceCandidate(args, discovery.devices);
    if (!existing?.deviceId) {
      if (args.device.deviceId) {
        return await reserveIosProvisionDeviceLifecycle(
          args,
          deps,
          { deviceId: args.device.deviceId },
          totalDeadlineMs,
          signal,
        );
      }
      return undefined;
    }
    return await reserveIosProvisionDeviceLifecycle(args, deps, existing, totalDeadlineMs, signal);
  }

  /**
   * Reserve a not-yet-created iOS simulator by name. This is the one provision
   * reservation with no stable identity to key on, so it maps a post-deadline
   * coordinator rejection to the same `ProvisionDeviceError("timeout")` the
   * stable paths raise instead of leaking an opaque platform failure.
   */
  async function reserveIosSelectorProvisionDeviceLifecycle(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    totalDeadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<VirtualDeviceLifecycleLease> {
    try {
      return await deps.lifecycleCoordinator.reserve(
        { kind: "selector", platform: "ios", selector: args.device.name },
        { operation: "provision", deadlineMs: totalDeadlineMs, signal },
      );
    } catch (error) {
      rethrowDeviceLifecycleReservationFailure(
        error,
        deps.timer,
        totalDeadlineMs,
        (detail) =>
          new ProvisionDeviceError(
            "timeout",
            `Timed out provisioning ios device '${args.device.name}': ${detail}.`,
          ),
        "waiting for the device lifecycle reservation",
      );
    }
  }

  async function reserveIosProvisionDeviceLifecycle(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    device: Pick<DeviceInfo, "deviceId">,
    totalDeadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<VirtualDeviceLifecycleLease> {
    if (!device.deviceId) {
      throw new ProvisionDeviceError(
        "identity_conflict",
        `Exact iOS simulator '${args.device.name}' has no UDID.`,
      );
    }
    const target: StableDeviceTarget = { platform: "ios", stableId: device.deviceId };
    return await reserveStableDeviceLifecycle(
      target,
      {
        platform: target.platform,
        name: args.device.name,
        deviceId: target.stableId,
      },
      deps.timer,
      totalDeadlineMs,
      {
        requestAbortSignal: signal,
        timeoutError: (detail) =>
          new ProvisionDeviceError(
            "timeout",
            `Timed out provisioning ${target.platform} device '${args.device.name}': ${detail}.`,
          ),
        operation: "provision",
        coordinator: deps.lifecycleCoordinator,
      },
    );
  }

  function provisionDeviceLifecycleIdentity(
    args: ProvisionDeviceArgs,
    provisioned: DeviceInfo,
    runtimeDevice?: BootedDevice,
  ): NonNullable<ProvisionDeviceLifecycleOutcome["device"]> {
    const stableId =
      args.device.platform === "android"
        ? args.device.name
        : (provisioned.deviceId ?? args.device.deviceId ?? args.device.name);
    return {
      platform: args.device.platform,
      stableId,
      name: provisioned.name,
      ...(runtimeDevice?.deviceId ? { runtimeDeviceId: runtimeDevice.deviceId } : {}),
    };
  }

  function prebootProvisionDeviceLifecycle(
    args: ProvisionDeviceArgs,
    provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>,
  ): ProvisionDeviceLifecycleOutcome {
    return {
      state: "created_not_ready",
      phase: provisioned.created ? "created" : "adopted",
      device: provisionDeviceLifecycleIdentity(args, provisioned.device),
    };
  }

  async function runProvisionDeviceLifecycle(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    {
      recordLifecycle,
      totalDeadlineMs,
      signal,
    }: {
      recordLifecycle: RecordProvisionDeviceLifecycle;
      totalDeadlineMs: number;
      signal: AbortSignal | undefined;
    },
  ): Promise<Record<string, unknown>> {
    const perf = createPerformanceTracker(true);
    perf.serial("provisionDevice");
    const deviceManager = deps.deviceManagerFactory();
    let lifecycleLease: VirtualDeviceLifecycleLease | undefined;
    let provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>> | undefined;
    let observedRuntimeDevice: BootedDevice | undefined;
    let creationStarted = false;
    const settlementState: ProvisionSettlementState = { bindingSettlements: [] };
    const notifyResourcesChangedBestEffort = () => {
      void deps.notifyResourcesChanged().catch((error: unknown) => {
        logger.warn(
          `[DeviceTools] Failed to notify resource changes after provisioning ${args.device.platform} device '${args.device.name}': ${errorMessage(error)}`,
          error,
        );
      });
    };
    try {
      if (args.device.platform === "android") {
        lifecycleLease = await reserveStableDeviceLifecycle(
          { platform: "android", stableId: args.device.name },
          {
            platform: "android",
            name: args.device.name,
            deviceId: args.device.name,
          },
          deps.timer,
          totalDeadlineMs,
          {
            requestAbortSignal: signal,
            timeoutError: (detail) =>
              new ProvisionDeviceError(
                "timeout",
                `Timed out provisioning Android AVD '${args.device.name}': ${detail}.`,
              ),
            operation: "provision",
            coordinator: deps.lifecycleCoordinator,
          },
        );
      } else {
        // Scope the iOS lifecycle reservation too: it runs `getDeviceImagesDetailed`
        // (→ `simctl list`) before the provision/boot scopes, so its discovery
        // command would otherwise be missing from perfTiming (see PerfContext).
        lifecycleLease = await runWithPerfTracker(ambientPerfFor(perf), async () => {
          const existing = await reserveExistingIosProvisionDeviceLifecycle(
            args,
            deps,
            deviceManager,
            totalDeadlineMs,
            signal,
          );
          return (
            existing ??
            (await reserveIosSelectorProvisionDeviceLifecycle(args, deps, totalDeadlineMs, signal))
          );
        });
      }
      const deviceCreationGate = deps.deviceCreationGateFactory();
      provisioned = await provisionExactDevice(
        args,
        deps.exactDeviceProvisionerFactory(deviceManager, deviceCreationGate),
        perf,
        deps.timer,
        {
          totalDeadlineMs: totalDeadlineMs,
          markDeviceCreationStarted: () => {
            creationStarted = true;
          },
          lifecycleLease: lifecycleLease,
          collectPendingSettlement: (settlement) => {
            settlementState.exactProvisioning = settlement;
          },
          signal: signal,
        },
      );
      const createdByRequest = provisioned.created;
      recordLifecycle(prebootProvisionDeviceLifecycle(args, provisioned));
      if (!args.boot) {
        if (provisioned.created) {
          // Device creation is committed. Do not make its response or rollback
          // depend on an advisory resource notification.
          notifyResourcesChangedBestEffort();
        }
        perf.end();
        return buildProvisionDeviceResult(args, provisioned, createdByRequest, perf, undefined);
      }
      // Ambient scope (only under --debug-perf) so the emulator/simctl boot
      // commands attribute their time into this provisioning tree. Capture the
      // narrowed `provisioned`/`lifecycleLease` in consts first: the arrow
      // closure would otherwise widen the `let`s back to `| undefined`.
      const provisionedDevice = provisioned;
      const bootLifecycleLease = lifecycleLease;
      const booted = await runWithPerfTracker(ambientPerfFor(perf), () =>
        bootExactProvisionedDevice(args, deps, deviceManager, deviceCreationGate, {
          provisioned: provisionedDevice,
          perf: perf,
          totalDeadlineMs: totalDeadlineMs,
          lifecycleLease: bootLifecycleLease,
          signal: signal,
          settlementState: settlementState,
          onBooted: (device) => {
            observedRuntimeDevice = device;
            recordLifecycle({
              state: "created_not_ready",
              phase: "readiness",
              device: provisionDeviceLifecycleIdentity(args, provisionedDevice.device, device),
            });
          },
        }),
      );
      if (provisioned.created || booted.source === "cold-boot") {
        // Session and pool ownership are already committed by
        // `bootExactProvisionedDevice`. A best-effort resource notification is
        // safe to swallow here: failing it must neither turn that committed
        // success into destructive rollback nor strand the bound session.
        notifyResourcesChangedBestEffort();
      }
      perf.end();
      return buildProvisionDeviceResult(args, provisioned, createdByRequest, perf, booted);
    } catch (error) {
      perf.end();
      return await rethrowFailedProvisionDeviceLifecycle(args, deps, deviceManager, provisioned, {
        creationStarted: creationStarted,
        takeLifecycleLease: () => {
          const rollbackLease = lifecycleLease;
          lifecycleLease = undefined;
          return rollbackLease;
        },
        error: error,
        unownedColdBootSettlement: settlementState.unownedColdBootSettlement,
        pendingMutationSettlement: settlementState.exactProvisioning,
        recordLifecycle: recordLifecycle,
        observedRuntimeDevice: observedRuntimeDevice,
      });
    } finally {
      releaseProvisionLifecycleReservations(settlementState, () => lifecycleLease);
    }
  }

  function releaseProvisionLifecycleReservations(
    settlementState: ProvisionSettlementState,
    getLifecycleLease: () => VirtualDeviceLifecycleLease | undefined,
  ): void {
    const settlements = [
      ...settlementState.bindingSettlements,
      ...(settlementState.unownedColdBootSettlement
        ? [settlementState.unownedColdBootSettlement]
        : []),
    ];
    if (settlements.length > 0) {
      // A cancelled autolock binding may still be durably releasing its
      // session. Keep both identity reservations until that rollback (and
      // any cold-boot shutdown) is terminal, without delaying the caller.
      void Promise.allSettled(settlements)
        .then(() => {
          releaseProvisionReadiness(settlementState.readinessReservation);
          getLifecycleLease()?.release();
        })
        .catch((error: unknown) => {
          logger.warn(
            `[DeviceTools] Deferred provision reservation release failed: ${errorMessage(error)}`,
            error,
          );
        });
    } else {
      releaseProvisionReadiness(settlementState.readinessReservation);
      getLifecycleLease()?.release();
    }
  }

  async function provisionExactDevice(
    args: ProvisionDeviceArgs,
    provisioner: ExactDeviceProvisioner,
    perf: ReturnType<typeof createPerformanceTracker>,
    timer: Timer,
    {
      totalDeadlineMs,
      markDeviceCreationStarted,
      lifecycleLease,
      collectPendingSettlement,
      signal,
    }: {
      totalDeadlineMs: number;
      markDeviceCreationStarted: () => void;
      lifecycleLease: VirtualDeviceLifecycleLease;
      collectPendingSettlement: (settlement: Promise<unknown>) => void;
      signal: AbortSignal | undefined;
    },
  ): Promise<Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>> {
    perf.startOperation("provisionExactDevice");
    try {
      // Establish `perf` as the ambient tracker (only under --debug-perf; see
      // ambientPerfFor) so the exact provisioner and every platform CLI it drives
      // (avdmanager, sdkmanager, adb, simctl, xcodebuild) record their command
      // spans into this same timing tree.
      return await runWithPerfTracker(ambientPerfFor(perf), () =>
        runProvisionDeviceWithinDeadline(
          timer,
          totalDeadlineMs,
          signal,
          "provisioning the exact device",
          async (deadlineSignal) =>
            await provisioner.provision({
              platform: args.device.platform,
              name: args.device.name,
              ...(args.device.deviceId === undefined ? {} : { deviceId: args.device.deviceId }),
              spec: args.device.spec,
              onBeforeCreate: markDeviceCreationStarted,
              lifecycleLease,
              deadlineMs: totalDeadlineMs,
              signal: deadlineSignal,
            }),
          collectPendingSettlement,
        ),
      );
    } finally {
      perf.endOperation("provisionExactDevice");
    }
  }

  function createProvisionBootService(
    deps: DeviceToolsDependencies,
    deviceManager: PlatformDeviceManager,
    deviceCreationGate: DeviceCreationGate,
    lifecycleLease: VirtualDeviceLifecycleLease,
  ): DeviceBootService {
    return new DeviceBootService({
      deviceManager,
      deviceMatcher: deps.deviceMatcherFactory(),
      displayInventory: deps.displayInventory,
      deviceCreationGate,
      deviceProvisioner: deps.deviceProvisionerFactory(),
      matchingStrategy: DEVICE_POOL_MATCHING,
      timer: deps.timer,
      lifecycleLease,
      allowExternalLeaseAdoptionRecheck: true,
      lifecycleCoordinator: deps.lifecycleCoordinator,
      onAndroidColdBootTrackingChanged: () => {
        void deps.notifyDeviceInventoryResourcesChanged(false).catch((error) => {
          logger.warn(
            `[DeviceTools] Resource notify after cold-boot tracking change failed: ${errorMessage(error)}`,
            error,
          );
        });
      },
    });
  }

  function provisionSessionArgs(args: ProvisionDeviceArgs): StartDeviceArgs {
    return {
      platform: args.device.platform,
      name: args.device.name,
      timeoutMs: args.timeoutMs,
      __mcpSessionId: args.__mcpSessionId,
      ...(args.__oneShotCli ? { __oneShotCli: true } : {}),
    };
  }

  function provisionSessionBindingOptions(
    args: ProvisionDeviceArgs,
    readinessReservation: DeviceReadinessReservation | undefined,
    settlementState: ProvisionSettlementState,
  ) {
    return {
      readinessReservationOwners: readinessReservation
        ? new Set([readinessReservation.owner])
        : undefined,
      verifiedAndroidAvdIdentity: undefined,
      autolockEnabled: captureAutolockPolicy(getDeviceToolsDependencies().env),
      achievedReadiness: resolveProvisionDeviceAchievedReadiness(args.readiness),
      collectCancellationSettlement: (settlement: Promise<void>) => {
        settlementState.bindingSettlements.push(settlement);
      },
    };
  }

  function assertProvisionAndroidDiscovery(
    args: ProvisionDeviceArgs,
    succeededPlatforms: ReadonlySet<string>,
  ): void {
    if (!succeededPlatforms.has("android")) {
      throw new ProvisionDeviceError(
        "discovery_incomplete",
        `Cannot provision Android device '${args.device.name}' because booted-device discovery did not complete.`,
        true,
      );
    }
  }

  function assertProvisionAndroidIdentities(
    args: ProvisionDeviceArgs,
    devices: BootedDevice[],
  ): void {
    if (
      devices
        .filter((device) => device.platform === "android")
        .some(isUnresolvedAndroidEmulatorName)
    ) {
      throw new ProvisionDeviceError(
        "discovery_incomplete",
        `Cannot provision Android device '${args.device.name}' because a running emulator's AVD identity has not resolved yet; retry.`,
        true,
      );
    }
  }

  function assertProvisionIosIdentity(
    args: ProvisionDeviceArgs,
    provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>,
  ): void {
    if (args.device.platform === "ios" && !provisioned.device.deviceId) {
      throw new ProvisionDeviceError(
        "identity_conflict",
        `Exact iOS simulator '${args.device.name}' has no UDID.`,
      );
    }
  }

  function assertProvisionIosBootIdentity(
    args: ProvisionDeviceArgs,
    provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>,
    boot: DeviceBootResult,
  ): void {
    if (args.device.platform === "ios" && boot.device.deviceId !== provisioned.device.deviceId) {
      throw new ProvisionDeviceError(
        "identity_conflict",
        `Exact iOS simulator '${args.device.name}' resolved to unexpected UDID '${boot.device.deviceId}'.`,
      );
    }
  }

  async function bootExactProvisionedDevice(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    deviceManager: PlatformDeviceManager,
    deviceCreationGate: DeviceCreationGate,
    {
      provisioned,
      perf,
      totalDeadlineMs,
      lifecycleLease,
      signal,
      settlementState,
      onBooted,
    }: ProvisionBootOptions,
  ): Promise<ProvisionBootResult> {
    const requestedIdentity = `platform=${args.device.platform} name=${args.device.name}`;
    const operationSignal = combineAbortSignals(signal, lifecycleLease.signal)!;
    const bootService = createProvisionBootService(
      deps,
      deviceManager,
      deviceCreationGate,
      lifecycleLease,
    );
    let boot: DeviceBootResult | undefined;
    let ownershipTransferred = false;
    let readinessReservation: DeviceReadinessReservation | undefined;
    let resources: DeviceResourceConfigurationResult | undefined;
    try {
      const alreadyBooted = await runProvisionDeviceWithinDeadline(
        deps.timer,
        totalDeadlineMs,
        operationSignal,
        "discovering an already-running exact device",
        async (deadlineSignal) => {
          if (args.device.platform === "android") {
            const discovery = await deviceManager.getBootedDevicesDetailed("android", {
              bypassAndroidDeviceListCache: true,
              signal: deadlineSignal,
            });
            assertProvisionAndroidDiscovery(args, discovery.succeededPlatforms);
            // FUNNEL 1: fold the fresh observation into the pool BEFORE deciding
            // whether it resolves the requested identity, so a discovered
            // placeholder quarantines any stale pooled label under this serial
            // even when the request itself is about to fail closed (#7177
            // review).
            await reconcileDiscoveryObservation(discovery.devices, "provisionDevice-exact");
            assertProvisionAndroidIdentities(args, discovery.devices);
            return discovery.devices;
          }
          const alreadyBootedDevices = await deviceManager.getBootedDevices(args.device.platform);
          // FUNNEL 1: acquisition matches this observation against the pooled
          // entry it is about to hand out (#6863 review).
          await reconcileDiscoveryObservation(alreadyBootedDevices, "provisionDevice-exact");
          return alreadyBootedDevices;
        },
      );
      const exactBootedDevice = findExactProvisionedBootedDevice(
        args.device.platform,
        alreadyBooted,
        provisioned.device,
      );
      assertProvisionIosIdentity(args, provisioned);
      perf.startOperation("bootDevice");
      // Boot and automation readiness share one provision budget. Reserve the
      // readiness slice up front, the way `applyProvisionDeviceResources` does,
      // so a slow cold boot cannot consume the whole deadline and leave CtrlProxy
      // setup with a millisecond ("readiness budget exhausted before setup lock").
      // The slice is capped at half the remaining budget so a short request still
      // gets a usable boot window; no budget is inflated.
      const readinessShareMs = Math.min(
        Math.max(0, totalDeadlineMs - deps.timer.now()) / 2,
        args.readiness === "automation"
          ? serverConfig.getRunnerReadinessTimeoutMs()
          : START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
      );
      boot = await bootService.boot({
        operationName: "provisionDevice",
        platform: args.device.platform,
        deviceId:
          exactBootedDevice?.deviceId ?? provisioned.device.deviceId ?? provisioned.device.name,
        totalDeadlineMs: totalDeadlineMs - readinessShareMs,
        signal: operationSignal,
        // A just-created AVD's first boot is a genuine cold boot; opt its
        // Android readiness wait into bounded ADB-offline recovery (#7054). An
        // already-running adopted exact device never reaches the cold-boot path,
        // so the flag is a no-op there and needs no extra guard here.
        freshProvision: provisioned.created === true,
      });
      perf.endOperation("bootDevice");
      assertProvisionIosBootIdentity(args, provisioned, boot);
      validatePooledDeviceMapping(boot.device, requestedIdentity);
      onBooted(boot.device);
      readinessReservation = await runProvisionDeviceWithinDeadline(
        deps.timer,
        totalDeadlineMs,
        operationSignal,
        "reserving device readiness",
        async (reservationSignal) => {
          const reservation = await reserveProvisionDeviceReadiness(args, boot!);
          if (reservationSignal.aborted) {
            void reservation?.().catch((error) =>
              logger.warn(`Late provision reservation release failed: ${error}`),
            );
            reservationSignal.throwIfAborted();
          }
          return reservation;
        },
      );
      clearColdBootShutdownMarker(boot.source, boot.device.deviceId);
      const sessionId = await trackDeviceAcquisitionReadiness(
        deviceReadinessLockKey(boot.device.platform, boot.device.deviceId),
        async () => {
          operationSignal.throwIfAborted();
          resources = await applyProvisionDeviceResources(
            args,
            deps,
            boot!.device,
            totalDeadlineMs,
            operationSignal,
          );
          operationSignal.throwIfAborted();
          await ensureProvisionDeviceReadiness(args, deps, boot!.device, requestedIdentity, {
            totalDeadlineMs: totalDeadlineMs,
            perf: perf,
            signal: operationSignal,
          });
          operationSignal.throwIfAborted();
          validatePooledDeviceMapping(boot!.device, requestedIdentity);
          publishWarmDeviceReady(boot!.source, boot!.device.deviceId);
          return await runProvisionDeviceWithinDeadline(
            deps.timer,
            totalDeadlineMs,
            operationSignal,
            "binding the device session",
            async () =>
              await bindBootedDeviceSession(
                boot!.device,
                provisionSessionArgs(args),
                provisioned.device,
                boot!.processHandle,
                // Our own stable-name readiness reservation must not deny our
                // own bind when the pooled incarnation changed during readiness.
                provisionSessionBindingOptions(args, readinessReservation, settlementState),
              ),
            (settlement) => {
              settlementState.bindingSettlements.push(settlement);
            },
          );
        },
      );
      ownershipTransferred = true;
      return {
        device: boot.device,
        sessionId,
        source: boot.source,
        sourceImage: boot.sourceImage,
        resources,
      };
    } catch (error) {
      if (!ownershipTransferred) {
        settlementState.unownedColdBootSettlement = cancelUnownedColdBoot(boot);
      }
      throw error;
    } finally {
      settlementState.readinessReservation = readinessReservation;
    }
  }

  function releaseProvisionReadiness(
    releaseReservation: DeviceReadinessReservation | undefined,
  ): void {
    // Session ownership is already committed on success. A delayed mutex-backed
    // reservation release must neither turn that success into destructive rollback
    // nor replace the original failure. Keep the balanced release queued.
    void releaseReservation?.().catch((error) =>
      logger.warn(`Provision readiness release failed: ${error}`),
    );
  }

  /**
   * The `DeviceReadinessLevel` actually achieved by `provisionDevice` for the
   * requested `readiness` option. `"automation"` runs `ensureCtrlProxyReady`
   * in `ensureProvisionDeviceReadiness` and reaches `automationReady`;
   * `"none"` deliberately skips that setup, leaving the device merely booted
   * (#6227 round 6).
   */
  function resolveProvisionDeviceAchievedReadiness(
    readiness: ProvisionDeviceArgs["readiness"],
  ): DeviceReadinessLevel {
    return readiness === "automation" ? "automationReady" : "booted";
  }

  async function applyProvisionDeviceResources(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    device: BootedDevice,
    deadlineMs: number,
    signal?: AbortSignal,
  ): Promise<DeviceResourceConfigurationResult | undefined> {
    if (!args.resources) {
      return undefined;
    }
    // Leave readiness and session binding time inside the existing total budget.
    // On short requests, split the remaining time rather than exhausting it in resources.
    const remainingMs = Math.max(0, deadlineMs - deps.timer.now());
    const completionBudgetMs = Math.min(
      remainingMs / 2,
      args.readiness === "automation"
        ? serverConfig.getRunnerReadinessTimeoutMs()
        : START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    );
    const resourceDeadlineMs = deadlineMs - completionBudgetMs;
    const configured = await deps.deviceResourceControllerFactory().setResources({
      device,
      resources: args.resources,
      deadlineMs: resourceDeadlineMs,
      signal,
    });
    const verified = await observeConfiguredDeviceResources(deps, configured, {
      device,
      deadlineMs: resourceDeadlineMs,
      signal,
    });
    assertSimulatorProfileProven(args, device, verified);
    return verified;
  }

  /**
   * iOS Simulator workload profiles are all-or-nothing (#6695): when any requested
   * entry cannot be proven applied after the write and independent re-read, fail
   * provisioning before readiness and session binding. The thrown error flows through
   * the normal failed-provision lifecycle, which rolls back a device this operation
   * created, releases the lifecycle lease and never binds a session. Overrides already
   * written to an adopted simulator are left in place (recorded as AutoMobile-owned).
   */
  function assertSimulatorProfileProven(
    args: ProvisionDeviceArgs,
    device: BootedDevice,
    result: DeviceResourceConfigurationResult,
  ): void {
    if (device.platform !== "ios" || resolveIosDeviceKind(device) !== "simulator") {
      return;
    }
    // The independent re-read wins only by direct contradiction: an observed
    // unknown/unsupported (a failed or timed-out read) never overrides a state the
    // controller proved, so a transient read error cannot fail provisioning.
    const states = mergeProvenResourceStates(result.resources, result.observed?.resources);
    const drift = computeDeviceResourceDrift(result.requested, states);
    if (drift.length === 0 && result.success) {
      return;
    }
    const detail = drift.length
      ? drift
          .map(
            (entry) =>
              `${entry.resource} (${entry.kind}: expected ${entry.expected}, observed ${entry.observed.state})`,
          )
          .join(", ")
      : "resource configuration did not report success";
    throw new ProvisionDeviceError(
      "resource_profile_unproven",
      `Requested resource profile could not be proven applied on iOS simulator '${args.device.name}'; no session was bound. Unproven: ${detail}. Overrides already written to an adopted simulator remain; run reconcileDeviceResources with repair, or setDeviceResources, to change them.`,
      // Only unreadable evidence (every entry a command failure) is worth retrying.
      drift.length > 0 && drift.every((entry) => entry.kind === "commandFailure"),
      { resourceDrift: drift, deviceId: device.deviceId },
    );
  }

  async function reserveProvisionDeviceReadiness(
    args: ProvisionDeviceArgs,
    boot: DeviceBootResult,
  ): Promise<DeviceReadinessReservation | undefined> {
    const daemonState = DaemonState.getInstance();
    if (!daemonState.isInitialized()) {
      return undefined;
    }
    // Reserving may reboot the device during readiness recovery, and the
    // readiness that follows resets the shared per-device CtrlProxy manager and
    // rewrites resource settings. Prove this client owns the device first, the
    // same way `reserveInitialDeviceForReadiness` does for startDevice.
    return await daemonState
      .getDevicePool()
      .reserveDeviceForReadiness(
        boot.device.deviceId,
        boot.device,
        boot.sourceImage?.name ?? boot.device.name,
        undefined,
        args.__oneShotCli
          ? { oneShotCli: true }
          : args.__mcpSessionId
            ? { mcpSessionId: args.__mcpSessionId }
            : undefined,
      );
  }

  async function ensureProvisionDeviceReadiness(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    device: BootedDevice,
    requestedIdentity: string,
    {
      totalDeadlineMs,
      perf,
      signal,
    }: {
      totalDeadlineMs: number;
      perf: ReturnType<typeof createPerformanceTracker>;
      signal: AbortSignal | undefined;
    },
  ): Promise<void> {
    if (args.readiness !== "automation") {
      return;
    }
    const ctrlProxySetup = deps.ensureCtrlProxyReady ?? ensureCtrlProxyReady;
    await ctrlProxySetup({
      device,
      requestedIdentity,
      totalDeadlineMs,
      readinessTimeoutMs: args.timeoutMs ?? serverConfig.getRunnerReadinessTimeoutMs(),
      skipCtrlProxyDownload: serverConfig.isSkipCtrlProxyDownloadEnabled(),
      perf,
      signal,
    });
  }

  // oxlint-disable-next-line complexity -- operation fields and canonical device projection share one response boundary.
  function buildProvisionDeviceResult(
    args: ProvisionDeviceArgs,
    provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>,
    createdByRequest: boolean,
    perf: ReturnType<typeof createPerformanceTracker>,
    booted:
      | {
          device: BootedDevice;
          sessionId: string;
          sourceImage?: DeviceInfo;
          resources?: DeviceResourceConfigurationResult;
        }
      | undefined,
  ): Record<string, unknown> {
    const pooled = booted
      ? (initializedDevicePool()?.getDevice(booted.device.deviceId) ?? undefined)
      : undefined;
    const description = describeDevice({
      kind: "provisioned",
      provisioned,
      booted: booted?.device,
      pooled,
      discovery: booted?.sourceImage,
      session: booted ? { sessionId: booted.sessionId } : undefined,
      serviceStatus: booted
        ? args.readiness === "automation"
          ? { installed: true, enabled: true, running: true, isCompatible: true }
          : { installed: true, enabled: true, running: false, isCompatible: true }
        : undefined,
    });
    return {
      ...(booted?.resources ? { resources: booted.resources } : {}),
      device: projectProvisionedDevice(description),
      requestedSpec: args.device.spec,
      resolvedSpec: provisioned.resolvedSpec,
      displayCutout:
        provisioned.resolvedSpec.displayCutout ??
        classifyDisplayCutout(args.device.platform, provisioned.resolvedSpec.deviceType),
      created: createdByRequest,
      adopted: !createdByRequest,
      lifecycleState: booted ? "ready" : createdByRequest ? "created" : "adopted",
      readiness: {
        mode: args.readiness,
        status: booted
          ? args.readiness === "automation"
            ? "automation_ready"
            : "device_ready"
          : "not_requested",
      },
      ...(booted ? { sessionId: booted.sessionId } : {}),
      timing: perf.getTimings(),
    };
  }

  function recoveryField(recovery: ProvisionDeviceRecoveryEvidence | undefined) {
    return recovery ? { recovery } : {};
  }

  function recoveryFromError(error: unknown): ProvisionDeviceRecoveryEvidence | undefined {
    return error instanceof ProvisionDeviceError ? error.diagnostics.recovery : undefined;
  }

  function provisionDeviceErrorResponse(
    error: unknown,
    recovery?: ProvisionDeviceRecoveryEvidence,
  ) {
    const lifecycle = lifecycleForProvisionResponseError(error);
    const requestOutcome = {
      ...(lifecycle ? { lifecycle } : {}),
      ...recoveryField(recovery ?? recoveryFromError(error)),
    };
    if (error instanceof DaemonHandoffInterruptionError) {
      return createToolErrorResponse(error.code, error.message, {
        ...requestOutcome,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
      });
    }
    if (error instanceof ProvisionDeviceRollbackError) {
      return createToolErrorResponse(error.code, error.message, {
        ...requestOutcome,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...provisionDeviceDiagnosticFields(error.provisionFailure),
        },
        provisionFailure: {
          code: error.provisionFailure.code,
          message: error.provisionFailure.message,
        },
        cleanup: error.cleanup,
      });
    }
    if (error instanceof ProvisionDeviceError) {
      return createToolErrorResponse(error.code, error.message, {
        ...requestOutcome,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...provisionDeviceDiagnosticFields(error),
        },
      });
    }
    return createToolErrorResponse("platform_command_failed", errorMessage(error), requestOutcome);
  }

  function provisionDeviceDiagnosticFields(error: ProvisionDeviceError) {
    const diagnostics = error.diagnostics;
    return {
      ...(diagnostics.providerCode ? { providerCode: diagnostics.providerCode } : {}),
      ...(diagnostics.readinessPhase ? { readinessPhase: diagnostics.readinessPhase } : {}),
      ...(diagnostics.attempt !== undefined ? { attempt: diagnostics.attempt } : {}),
      ...(diagnostics.incidentId ? { incidentId: diagnostics.incidentId } : {}),
      ...(diagnostics.deviceId ? { deviceId: diagnostics.deviceId } : {}),
      ...(diagnostics.ownerPid !== undefined ? { ownerPid: diagnostics.ownerPid } : {}),
      ...(diagnostics.retryAfterMs !== undefined ? { retryAfterMs: diagnostics.retryAfterMs } : {}),
      ...(diagnostics.resourceDrift ? { resourceDrift: diagnostics.resourceDrift } : {}),
      ...(diagnostics.runtimeCompatibility
        ? { runtimeCompatibility: diagnostics.runtimeCompatibility }
        : {}),
      daemonBuild: `${DAEMON_VERSION}+${getCurrentBuildIdentity().buildId}`,
    };
  }

  function mergeProvenResourceStates(
    controller: DeviceResourceConfigurationResult["resources"],
    observed: DeviceResourceConfigurationResult["resources"] | undefined,
  ): DeviceResourceConfigurationResult["resources"] {
    const merged = { ...controller };
    for (const [resource, status] of Object.entries(observed ?? {}) as [
      keyof typeof merged,
      NonNullable<(typeof merged)[keyof typeof merged]>,
    ][]) {
      const proven = merged[resource];
      const unreadable = status.state === "unknown" || status.state === "unsupported";
      if (!(unreadable && proven && proven.state !== "unknown" && proven.state !== "unsupported")) {
        merged[resource] = status;
      }
    }
    return merged;
  }

  return (input: ProvisionDeviceArgs, progress?: ProgressCallback, signal?: AbortSignal) =>
    runWithAutolockPolicy(getDeviceToolsDependencies().env, () =>
      provisionDeviceHandler(input, progress, signal),
    );
}
