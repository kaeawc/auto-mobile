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
import { getCurrentBuildIdentity } from "../daemon/buildIdentity";
import { DAEMON_VERSION } from "../daemon/constants";
import {
  DAEMON_HANDOFF_INTERRUPTED_ERROR_CODE,
  DaemonHandoffInterruptionError,
} from "../daemon/daemonHandoffInterruption";
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
  ProvisionDeviceError,
} from "../devices/exactDeviceProvisioning";
import {
  ProvisionDeviceOperationConflictError,
  ProvisionDeviceOperationFailedError,
  ProvisionDeviceOperationInProgressError,
  ProvisionDeviceOperationSupersededError,
  type ProvisionDeviceLifecycleOutcome,
  type ProvisionDeviceOperationBeginResult,
  type ProvisionDeviceOperationStore,
} from "../db/provisionDeviceOperationRepository";
import { type VirtualDeviceLifecycleLease } from "../devices/virtualDeviceLifecycleCoordinator";
import { DeviceTeardownService } from "../devices/deviceTeardownService";
import { getProvisionedDeviceTransportFence } from "../utils/provisionedDeviceTransportFence";
import { classifyDisplayCutout } from "../utils/displayCutout";
import {
  ActiveProvisionDeviceOperation,
  assertProvisionDeviceOperationAdmitted,
  attachProvisionDeviceLifecycle,
  awaitProvisionDeviceOperationBegin,
  cancelUnownedColdBoot,
  clearColdBootShutdownMarker,
  createProvisionDeviceResponse,
  createToolErrorResponse,
  FinalizedProvisionDeviceCompletionError,
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
  PROVISION_DEVICE_FINALIZATION_TTL_REFRESH_MS,
  PROVISION_DEVICE_OPERATION_TTL_MS,
  PROVISION_DEVICE_SESSION_RECOVERY_ERROR_CODE,
  PROVISION_DEVICE_SETTLEMENT_WAIT_MS,
  PROVISION_DEVICE_TTL_REFRESH_WAIT_MS,
  ProvisionDeviceCleanup,
  provisionDeviceDeadlineMs,
  provisionDeviceFingerprint,
  provisionDeviceSchema,
  ProvisionDeviceRollbackError,
  provisionDeviceTimeoutError,
  publishWarmDeviceReady,
  RecordProvisionDeviceLifecycle,
  releaseProvisionDeviceWaiter,
  reserveStableDeviceLifecycle,
  rethrowDeviceLifecycleReservationFailure,
  runOperationWithinDeadline,
  runProvisionDeviceWithinDeadline,
  StableDeviceTarget,
  TEARDOWN_OPERATION_RESULT_TTL_MS,
  TeardownDeviceArgs,
  TeardownToolResponse,
  validatePooledDeviceMapping,
  waitForProvisionDeviceSettlement,
  waitForSharedOperation,
  activeProvisionDeviceOperations,
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
  recordAcquiredSessionReadiness: (
    daemonState: DaemonState,
    sessionId: string,
    achievedReadiness: DeviceReadinessLevel,
  ) => void;
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
  recordLifecycle?: RecordProvisionDeviceLifecycle;
  lifecycleDevice?: NonNullable<ProvisionDeviceLifecycleOutcome["device"]>;
};

type ProvisionBootOptions = {
  provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>;
  perf: ReturnType<typeof createPerformanceTracker>;
  totalDeadlineMs: number;
  lifecycleLease: VirtualDeviceLifecycleLease;
  signal: AbortSignal | undefined;
  settlementState: ProvisionSettlementState;
  onBooted: (device: BootedDevice) => Promise<void>;
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

export function createProvisionDeviceHandler(hooks: ProvisioningHooks) {
  const {
    bindBootedDeviceSession,
    recordAcquiredSessionReadiness,
    ensureCtrlProxyReady,
    executeDeleteDevice,
  } = hooks;
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
    const fingerprint = provisionDeviceFingerprint(args);
    const active = activeProvisionDeviceOperations.get(args.operationId);
    if (active) {
      if (active.fingerprint !== fingerprint) {
        return createToolErrorResponse(
          "operation_conflict",
          `operationId '${args.operationId}' is already running with a different provisionDevice request.`,
        );
      }
      active.waiters += 1;
      return await awaitSharedProvisionDeviceOperation(args, active, signal);
    }

    const sharedController = new AbortController();
    const promise = executeProvisionDevice(args, fingerprint, sharedController.signal);
    const operation: ActiveProvisionDeviceOperation = {
      fingerprint,
      promise,
      controller: sharedController,
      waiters: 1,
    };
    activeProvisionDeviceOperations.set(args.operationId, operation);
    void promise.then(
      () => {
        if (activeProvisionDeviceOperations.get(args.operationId)?.promise === promise) {
          activeProvisionDeviceOperations.delete(args.operationId);
        }
      },
      () => {
        if (activeProvisionDeviceOperations.get(args.operationId)?.promise === promise) {
          activeProvisionDeviceOperations.delete(args.operationId);
        }
      },
    );
    return await awaitSharedProvisionDeviceOperation(args, operation, signal);
  };

  async function awaitSharedProvisionDeviceOperation(
    args: ProvisionDeviceArgs,
    operation: ActiveProvisionDeviceOperation,
    signal: AbortSignal | undefined,
  ) {
    try {
      const result = await waitForSharedOperation(operation.promise, signal);
      releaseProvisionDeviceWaiter(args.operationId, operation);
      return createProvisionDeviceResponse(result);
    } catch (error) {
      const cancelledOperation = releaseProvisionDeviceWaiter(args.operationId, operation, error);
      if (error instanceof DaemonHandoffInterruptionError) {
        if (cancelledOperation) {
          // The replacement daemon may replay this operation immediately.
          // Wait until the fenced attempt has persisted its retryable terminal
          // state, so replay cannot observe a stale "running" row.
          await operation.promise.catch((error) => {
            // Handoff already reports interruption; this wait only fences terminal persistence.
            logger.debug(`Provision handoff settlement rejected: ${errorMessage(error)}`);
          });
        }
        logger.warn(
          `[DeviceTools] provisionDevice ${args.operationId} interrupted by daemon handoff: ${errorMessage(error)}`,
          error,
        );
        return provisionDeviceErrorResponse(error, args.operationId);
      }
      if (isProvisionDeviceCallerAbort(error, signal)) {
        const settled = await waitForProvisionDeviceSettlement(
          operation.promise,
          getDeviceToolsDependencies().timer,
          PROVISION_DEVICE_SETTLEMENT_WAIT_MS,
        );
        if (!settled) {
          logger.warn(
            `[DeviceTools] provisionDevice ${args.operationId} caller cancellation stopped waiting for operation settlement.`,
          );
        }
        // The caller went away, which is not a provisioning failure: report it
        // with a code of its own, and say whether the operation was retained
        // for other callers (so its result can be collected by re-issuing the
        // same operationId) or was cancelled with this caller.
        logger.warn(
          `[DeviceTools] provisionDevice ${args.operationId} caller cancelled the request ` +
            `(operation ${cancelledOperation ? "cancelled" : "retained for other callers"}): ` +
            `${errorMessage(error)}`,
          error,
        );
        return createToolErrorResponse(
          "request_cancelled",
          cancelledOperation
            ? `provisionDevice request for operationId '${args.operationId}' was cancelled by ` +
                "the caller; no other caller was waiting, so the operation was cancelled too."
            : `provisionDevice request for operationId '${args.operationId}' was cancelled by ` +
                "the caller; the operation continued for other callers and its result can be collected by " +
                "re-issuing the same operationId.",
          { operationId: args.operationId, operationContinues: !cancelledOperation },
        );
      }
      logger.warn(
        `[DeviceTools] provisionDevice ${args.operationId} failed: ${errorMessage(error)}`,
        error,
      );
      return provisionDeviceErrorResponse(error, args.operationId);
    }
  }

  async function executeProvisionDevice(
    args: ProvisionDeviceArgs,
    fingerprint: string,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const deps = getDeviceToolsDependencies();
    const store = deps.provisionDeviceOperationStoreFactory();
    const nowMs = deps.timer.now();
    // Fence for every write this attempt makes to the operation row: an
    // attempt that is superseded (its row reclaimed by a retry or by the
    // expiry sweep) must not stamp its result over the attempt that replaced
    // it.
    const attemptId = deps.idGenerator.next();
    const recordLifecycle: RecordProvisionDeviceLifecycle = async (lifecycle) => {
      if (!(await store.recordLifecycleOutcome(args.operationId, attemptId, lifecycle))) {
        throw new ProvisionDeviceOperationSupersededError(args.operationId);
      }
    };
    // ONE absolute deadline for the whole request, anchored here and sliced
    // across every phase below. A replay runs up to three phases (waiting for
    // the stable-device lifecycle lease, revalidating the live session, then
    // re-running the lifecycle); computing a fresh `timer.now() + timeoutMs`
    // per phase re-granted the budget already burned by the previous one, so
    // one request could occupy ~3x its own timeoutMs -- past the operation
    // row's TTL and past the daemon's queued-request deadline, which only the
    // `reserveRollbackTime` form respects.
    const totalDeadlineMs = provisionDeviceDeadlineMs(args, deps.timer, true);
    const begin = store.begin(
      args.operationId,
      fingerprint,
      attemptId,
      nowMs,
      nowMs + PROVISION_DEVICE_OPERATION_TTL_MS,
    );
    let admissionAbandoned = false;
    let admissionError: unknown;

    const lifecycle = begin.then(async (operation) => {
      if (admissionAbandoned || deps.timer.now() >= totalDeadlineMs) {
        retireLateProvisionDeviceOperationBegin(
          store,
          args,
          attemptId,
          operation,
          admissionError ?? provisionDeviceTimeoutError("starting provision operation"),
        );
        throw admissionError ?? provisionDeviceTimeoutError("starting provision operation");
      }
      return await runAdmittedProvisionOperation(args, deps, operation, {
        store,
        attemptId,
        recordLifecycle,
        totalDeadlineMs,
        signal,
      });
    });
    void lifecycle.catch((error) => {
      // The admission waiter reports failure; this observer handles a late retired attempt.
      logger.debug(`Provision lifecycle rejection observed: ${errorMessage(error)}`);
    });

    let admissionConfirmed = false;
    try {
      await awaitProvisionDeviceOperationBegin(deps.timer, totalDeadlineMs, signal, begin);
      admissionConfirmed = true;
      return await lifecycle;
    } catch (error) {
      if (!admissionConfirmed) {
        // A storage call that ignores its deadline can still admit this attempt
        // after the caller has received its timeout. The continuation retires
        // that late claim under the same attempt fence before it can reach any
        // device mutation; a newer retry safely wins over that finalizer.
        admissionAbandoned = true;
        admissionError = error;
      }
      throw error;
    }
  }

  async function runAdmittedProvisionOperation(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    operation: ProvisionDeviceOperationBeginResult,
    {
      store,
      attemptId,
      recordLifecycle,
      totalDeadlineMs,
      signal,
    }: {
      store: ProvisionDeviceOperationStore;
      attemptId: string;
      recordLifecycle: RecordProvisionDeviceLifecycle;
      totalDeadlineMs: number;
      signal: AbortSignal | undefined;
    },
  ): Promise<Record<string, unknown>> {
    // In-progress and durable-terminal rows are observational queries, not
    // permission to enter the lifecycle. Throw before the catch below so this
    // attempt never stamps over the row it only queried.
    assertProvisionDeviceOperationAdmitted(operation, args.operationId);
    try {
      if (
        !operation.started &&
        (await canReplayCompletedProvisionDeviceOperation(
          args,
          deps,
          operation.result,
          totalDeadlineMs,
          signal,
        ))
      ) {
        const replayResult = backfillProvisionDeviceCutout(args, operation.result);
        // Unconditionally, even when the persisted result is byte-for-byte what
        // we are about to return: begin() moved this row to the EXCLUSIVE
        // non-terminal `replaying` status, so returning without completing it
        // would leave the claim held and make every later identical call report
        // operation_in_progress until the row's TTL (~30m) expires. Re-storing
        // an identical result is harmless; leaving the claim open is not.
        await completeProvisionDeviceOperation(store, args.operationId, attemptId, replayResult, {
          args: args,
          timer: deps.timer,
          totalDeadlineMs: totalDeadlineMs,
          signal: signal,
        });
        return replayResult;
      }
      if (!operation.started) {
        await releaseErroredProvisionDeviceSession(operation.result);

        // Sessions are daemon-local and are expired during daemon startup. A
        // replay of a completed boot operation therefore runs the idempotent
        // lifecycle again to bind a live session before reporting readiness.
        const rebound = await runProvisionDeviceLifecycle(
          args,
          deps,
          operation.reconcileExistingConfiguration,
          () => markProvisionDeviceCreationStarted(store, args.operationId, attemptId),
          { recordLifecycle: recordLifecycle, totalDeadlineMs: totalDeadlineMs, signal: signal },
        );
        const refreshed = preserveProvisionDeviceOwnership(operation.result, rebound);
        await completeProvisionDeviceOperation(store, args.operationId, attemptId, refreshed, {
          args: args,
          timer: deps.timer,
          totalDeadlineMs: totalDeadlineMs,
          signal: signal,
        });
        return refreshed;
      }

      const result = await runProvisionDeviceLifecycle(
        args,
        deps,
        operation.reconcileExistingConfiguration,
        () => markProvisionDeviceCreationStarted(store, args.operationId, attemptId),
        { recordLifecycle: recordLifecycle, totalDeadlineMs: totalDeadlineMs, signal: signal },
      );
      await completeProvisionDeviceOperation(store, args.operationId, attemptId, result, {
        args: args,
        timer: deps.timer,
        totalDeadlineMs: totalDeadlineMs,
        signal: signal,
      });
      return result;
    } catch (error) {
      if (error instanceof FinalizedProvisionDeviceCompletionError) {
        // Completion failures start an observed finalizer below. Do not await
        // or duplicate its failure write here; either can share the stalled
        // persistence boundary that made completion fail.
        throw error.completionError;
      }
      if (error instanceof McpSessionRecoveryInProgressError) {
        // Transient by construction ("cannot remap until recovery finishes"),
        // so the client is told to retry. A retry only works if this attempt's
        // row is terminal: an admitted attempt owns a "running" row, and
        // leaving it running would make every retry report
        // operation_in_progress for the whole operation TTL (~30m) with
        // nothing executing. A replay (started === false) owns an exclusive
        // "replaying" row, so it must be failed too or every retry would report
        // operation_in_progress for the rest of the TTL; store.fail() reverts a
        // replaying row to "succeeded" with its result intact, so this cannot
        // destroy a valid completed result.
        logger.warn(
          `[DeviceTools] provisionDevice ${args.operationId} deferred by MCP session ` +
            `recovery: ${errorMessage(error)}`,
          error,
        );
        await persistFailedProvisionDeviceOperation(
          store,
          args,
          attemptId,
          PROVISION_DEVICE_SESSION_RECOVERY_ERROR_CODE,
          {
            message: errorMessage(error),
            options: undefined,
            timer: deps.timer,
            totalDeadlineMs: totalDeadlineMs,
            signal: signal,
          },
        );
        throw error;
      }
      if (error instanceof DaemonHandoffInterruptionError) {
        logger.warn(
          `[DeviceTools] provisionDevice ${args.operationId} interrupted by daemon handoff: ${errorMessage(error)}`,
          error,
        );
        await persistFailedProvisionDeviceOperation(
          store,
          args,
          attemptId,
          DAEMON_HANDOFF_INTERRUPTED_ERROR_CODE,
          {
            message: errorMessage(error),
            options: undefined,
            timer: deps.timer,
            totalDeadlineMs: totalDeadlineMs,
            signal: signal,
          },
        );
        throw error;
      }
      if (error instanceof ProvisionDeviceOperationSupersededError) {
        // The row belongs to a newer attempt now; stamping this attempt's
        // failure on it would fail an operation that is still running.
        throw error;
      }
      const provisionError = toProvisionDeviceError(args, error);
      await persistFailedProvisionDeviceOperation(store, args, attemptId, provisionError.code, {
        message: provisionError.message,
        options: {
          clearCreationStarted:
            error instanceof ProvisionDeviceRollbackError && error.cleanup.status === "succeeded",
        },
        timer: deps.timer,
        totalDeadlineMs: totalDeadlineMs,
        signal: signal,
      });
      throw provisionError;
    }
  }

  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;

  interface PersistedProvisionDevice {
    name: string;
    platform: "android" | "ios";
    deviceId?: string;
  }

  function getPersistedProvisionDevice(
    result: Record<string, unknown>,
  ): PersistedProvisionDevice | undefined {
    const deviceRecord = asRecord(result.device);
    if (!deviceRecord) {
      return undefined;
    }
    if (typeof deviceRecord.name !== "string") {
      return undefined;
    }
    if (deviceRecord.platform !== "android" && deviceRecord.platform !== "ios") {
      return undefined;
    }
    const runtimeRecord = asRecord(deviceRecord.runtime);
    const identityRecord = asRecord(deviceRecord.identity);
    const runtimeDeviceId =
      typeof runtimeRecord?.deviceId === "string" ? runtimeRecord.deviceId : undefined;
    const stableId =
      typeof identityRecord?.stableId === "string" ? identityRecord.stableId : undefined;
    return {
      name: deviceRecord.name,
      platform: deviceRecord.platform,
      deviceId: runtimeDeviceId ?? stableId,
    };
  }

  function backfillProvisionDeviceCutout(
    args: ProvisionDeviceArgs,
    result: Record<string, unknown>,
  ): Record<string, unknown> {
    const displayCutout = classifyDisplayCutout(args.device.platform, args.device.spec.deviceType);
    const resolvedSpec = result.resolvedSpec;
    const resolvedSpecRecord =
      typeof resolvedSpec === "object" && resolvedSpec !== null && !Array.isArray(resolvedSpec)
        ? (resolvedSpec as Record<string, unknown>)
        : undefined;
    const resolvedDisplayCutout = resolvedSpecRecord?.displayCutout;
    const hasTopLevelCutout = typeof result.displayCutout === "string";
    const hasResolvedCutout = typeof resolvedDisplayCutout === "string";
    if (hasTopLevelCutout && hasResolvedCutout) {
      return result;
    }
    return {
      ...result,
      displayCutout: hasTopLevelCutout ? result.displayCutout : displayCutout,
      resolvedSpec: {
        ...(resolvedSpecRecord ?? args.device.spec),
        displayCutout: hasResolvedCutout ? resolvedDisplayCutout : displayCutout,
      },
    };
  }

  async function reserveProvisionDeviceReplayLifecycle(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    result: Record<string, unknown>,
    totalDeadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<VirtualDeviceLifecycleLease | undefined> {
    const device = getPersistedProvisionDevice(result);
    const stableId = device?.platform === "android" ? device.name : device?.deviceId;
    if (!device || !stableId) {
      return undefined;
    }
    return await reserveStableDeviceLifecycle(
      { platform: device.platform, stableId },
      {
        platform: device.platform,
        name: device.name,
        deviceId: device.deviceId ?? stableId,
      },
      deps.timer,
      totalDeadlineMs,
      {
        requestAbortSignal: signal,
        timeoutError: (detail) =>
          new ProvisionDeviceError(
            "timeout",
            `Timed out replaying provisioned ${device.platform} device '${device.name}': ${detail}.`,
          ),
        operation: "provision",
        coordinator: deps.lifecycleCoordinator,
      },
    );
  }

  async function canReplayCompletedProvisionDeviceOperation(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    result: Record<string, unknown>,
    totalDeadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const replayLease = await reserveProvisionDeviceReplayLifecycle(
      args,
      deps,
      result,
      totalDeadlineMs,
      signal,
    );
    const replaySignal = replayLease
      ? signal
        ? AbortSignal.any([signal, replayLease.signal])
        : replayLease.signal
      : signal;
    try {
      return (
        !args.boot ||
        (await revalidateProvisionDeviceReplay(args, deps, result, totalDeadlineMs, replaySignal))
      );
    } finally {
      replayLease?.release();
    }
  }

  async function revalidateLiveProvisionDeviceSession(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    result: Record<string, unknown>,
    totalDeadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const liveSession = getLiveProvisionDeviceSession(result);
    if (!liveSession) {
      return false;
    }
    // A replay can re-establish readiness for a persisted session whose cache
    // was lost during daemon recovery. Keep that setup, its live-session
    // recheck, and the readiness record in one device transaction: a tool that
    // resolves the session concurrently must join this marker rather than see
    // an unrecorded level after CtrlProxy setup and start a second reset/setup.
    return await trackDeviceAcquisitionReadiness(
      deviceReadinessLockKey(liveSession.device.platform, liveSession.device.deviceId),
      async () => {
        if (args.resources) {
          result.resources = await applyProvisionDeviceResources(
            args,
            deps,
            liveSession.device,
            totalDeadlineMs,
            signal,
          );
        }
        if (args.readiness === "automation") {
          const perf = createPerformanceTracker(true);
          perf.serial("provisionDeviceReplay");
          try {
            await ensureProvisionDeviceReadiness(
              args,
              deps,
              liveSession.device,
              `platform=${args.device.platform} name=${args.device.name}`,
              { totalDeadlineMs: totalDeadlineMs, perf: perf, signal: signal },
            );
          } finally {
            perf.end();
          }
        }
        const revalidatedSession = getPersistedProvisionDeviceSession(result);
        if (!revalidatedSession || !getLiveProvisionDeviceSession(result)) {
          return false;
        }
        const daemonState = DaemonState.getInstance();
        recordAcquiredSessionReadiness(
          daemonState,
          revalidatedSession.sessionId,
          resolveProvisionDeviceAchievedReadiness(args.readiness),
        );
        await daemonState
          .getDevicePool()
          .attachAutolockSessionToMcpSession(revalidatedSession.sessionId, args.__mcpSessionId);
        return true;
      },
    );
  }

  async function revalidateProvisionDeviceReplay(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    result: Record<string, unknown>,
    totalDeadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    try {
      return await revalidateLiveProvisionDeviceSession(
        args,
        deps,
        result,
        totalDeadlineMs,
        signal,
      );
    } catch (error) {
      // A transport routing conflict does not invalidate the healthy device session.
      if (error instanceof McpSessionRecoveryInProgressError) {
        throw error;
      }
      await releaseProvisionDeviceSession(result, "provision-device-replay-validation-failed");
      throw error;
    }
  }

  function getLiveProvisionDeviceSession(
    result: Record<string, unknown>,
  ): { device: BootedDevice } | undefined {
    const persistedSession = getPersistedProvisionDeviceSession(result);
    const daemonState = DaemonState.getInstance();
    if (!persistedSession || !daemonState.isInitialized()) {
      return undefined;
    }

    const session = daemonState.getSessionManager().getSession(persistedSession.sessionId);
    const pooledDevice = daemonState
      .getDevicePool()
      .getDeviceForSession(persistedSession.sessionId);
    if (
      session?.assignedDevice === persistedSession.deviceId &&
      session.platform === persistedSession.platform &&
      pooledDevice?.id === persistedSession.deviceId &&
      pooledDevice.platform === persistedSession.platform &&
      pooledDevice.status === "busy"
    ) {
      return { device: persistedSession.device };
    }
    return undefined;
  }

  function getPersistedProvisionDeviceSession(
    result: Record<string, unknown>,
  ):
    | { sessionId: string; deviceId: string; platform: "android" | "ios"; device: BootedDevice }
    | undefined {
    if (typeof result.sessionId !== "string") {
      return undefined;
    }
    const device = getPersistedProvisionDevice(result);
    if (!device?.deviceId) {
      return undefined;
    }
    const persistedDevice: BootedDevice = {
      name: device.name,
      platform: device.platform,
      deviceId: device.deviceId,
    };
    return {
      sessionId: result.sessionId,
      deviceId: device.deviceId,
      platform: device.platform,
      device: persistedDevice,
    };
  }

  async function releaseErroredProvisionDeviceSession(
    result: Record<string, unknown>,
  ): Promise<void> {
    const persistedSession = getPersistedProvisionDeviceSession(result);
    const daemonState = DaemonState.getInstance();
    if (!persistedSession || !daemonState.isInitialized()) {
      return;
    }
    const pooledDevice = daemonState
      .getDevicePool()
      .getDeviceForSession(persistedSession.sessionId);
    if (pooledDevice?.status !== "error") {
      return;
    }
    await releaseProvisionDeviceSession(result, "provision-device-errored-replay");
  }

  async function completeProvisionDeviceOperation(
    store: ProvisionDeviceOperationStore,
    operationId: string,
    attemptId: string,
    result: Record<string, unknown>,
    {
      args,
      timer,
      totalDeadlineMs,
      signal,
    }: {
      args: ProvisionDeviceArgs;
      timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
      totalDeadlineMs: number;
      signal: AbortSignal | undefined;
    },
  ): Promise<void> {
    try {
      await runOperationWithinDeadline(
        timer,
        totalDeadlineMs,
        signal,
        () => provisionDeviceTimeoutError("persisting the final operation result"),
        async () => {
          if (!(await store.complete(operationId, attemptId, result))) {
            throw new ProvisionDeviceOperationSupersededError(operationId);
          }
        },
      );
    } catch (error) {
      const superseded = error instanceof ProvisionDeviceOperationSupersededError;
      logger.warn(
        `[DeviceTools] provisionDevice ${operationId} could not persist its result: ` +
          `${errorMessage(error)}`,
        error,
      );
      const finalization = finalizeFailedProvisionDeviceCompletion(store, args, attemptId, result, {
        completionError: error,
        superseded: superseded,
        timer: timer,
      });
      try {
        await runOperationWithinDeadline(
          timer,
          totalDeadlineMs,
          signal,
          () => provisionDeviceTimeoutError("finalizing failed operation completion"),
          async () => await finalization,
        );
      } catch (finalizationError) {
        // Cleanup remains observed by finalizeFailedProvisionDeviceCompletion;
        // crossing the request deadline only detaches this wait.
        logger.debug(
          `[DeviceTools] Deferred provisionDevice ${operationId} completion cleanup: ` +
            `${errorMessage(finalizationError)}`,
        );
      }
      throw new FinalizedProvisionDeviceCompletionError(error);
    }
  }

  function retireLateProvisionDeviceOperationBegin(
    store: ProvisionDeviceOperationStore,
    args: ProvisionDeviceArgs,
    attemptId: string,
    operation: ProvisionDeviceOperationBeginResult,
    admissionError: unknown,
  ): void {
    if ("inProgress" in operation) {
      return;
    }
    const provisionError = toProvisionDeviceError(args, admissionError);
    void store
      .fail(args.operationId, attemptId, provisionError.code, provisionError.message)
      .then((retired) => {
        if (!retired) {
          logger.debug(
            `[DeviceTools] Late provisionDevice ${args.operationId} admission was superseded before finalization.`,
          );
        }
      })
      .catch((error: unknown) => {
        logger.warn(
          `[DeviceTools] Failed to retire late provisionDevice ${args.operationId} admission: ` +
            `${errorMessage(error)}`,
          error,
        );
      });
  }

  async function persistFailedProvisionDeviceOperation(
    store: ProvisionDeviceOperationStore,
    args: ProvisionDeviceArgs,
    attemptId: string,
    errorCode: string,
    {
      message,
      options,
      timer,
      totalDeadlineMs,
      signal,
    }: {
      message: string;
      options:
        | {
            clearCreationStarted?: boolean;
          }
        | undefined;
      timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
      totalDeadlineMs: number;
      signal: AbortSignal | undefined;
    },
  ): Promise<void> {
    // Start the fenced write even if no budget remains. A late settlement can
    // only update its own attempt, while skipping it entirely leaves a running
    // operation row that no retry may reclaim until TTL expiry.
    const persistence = store.fail(args.operationId, attemptId, errorCode, message, options);
    void persistence.catch((error: unknown) => {
      logger.warn(
        `[DeviceTools] Deferred provisionDevice ${args.operationId} failure persistence failed: ` +
          `${errorMessage(error)}`,
        error,
      );
    });
    try {
      await runProvisionDeviceWithinDeadline(
        timer,
        totalDeadlineMs,
        signal,
        "persisting failed operation result",
        async () => await persistence,
      );
    } catch (error) {
      // The caller receives the original provisioning failure. Persistence stays
      // observed and fenced in the background rather than extending that error
      // past the single request deadline.
      logger.debug(
        `[DeviceTools] Deferred provisionDevice ${args.operationId} failure persistence: ` +
          `${errorMessage(error)}`,
      );
    }
  }

  async function finalizeFailedProvisionDeviceCompletion(
    store: ProvisionDeviceOperationStore,
    args: ProvisionDeviceArgs,
    attemptId: string,
    result: Record<string, unknown>,
    {
      completionError,
      superseded,
      timer,
    }: {
      completionError: unknown;
      superseded: boolean;
      timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
    },
  ): Promise<void> {
    // A failed replay returns its row to succeeded when fail() settles. Release
    // the session first so no caller can claim that replay-visible old result
    // while the session it names is still being torn down.
    const ttlRefresh = superseded
      ? undefined
      : keepProvisionDeviceOperationAlive(store, args.operationId, attemptId, timer);
    try {
      if (ttlRefresh) {
        if (
          !(await waitForProvisionDeviceSettlement(
            ttlRefresh.ready,
            timer,
            PROVISION_DEVICE_TTL_REFRESH_WAIT_MS,
          ))
        ) {
          logger.warn(
            `[DeviceTools] provisionDevice ${args.operationId} TTL refresh did not settle before session release.`,
          );
        }
      }
      await releaseProvisionDeviceSession(
        result,
        superseded
          ? "provision-device-operation-superseded"
          : "provision-device-persistence-failed",
      );
    } catch (error) {
      logger.warn(
        `[DeviceTools] Deferred provisionDevice ${args.operationId} session release failed: ` +
          `${errorMessage(error)}`,
        error,
      );
    } finally {
      if (ttlRefresh) {
        if (
          !(await waitForProvisionDeviceSettlement(
            ttlRefresh.stop(),
            timer,
            PROVISION_DEVICE_TTL_REFRESH_WAIT_MS,
          ))
        ) {
          logger.warn(
            `[DeviceTools] provisionDevice ${args.operationId} TTL refresh did not settle after session release.`,
          );
        }
      }
    }

    if (superseded) {
      return;
    }

    const provisionError = toProvisionDeviceError(args, completionError);
    try {
      await store.fail(args.operationId, attemptId, provisionError.code, provisionError.message);
    } catch (error) {
      logger.warn(
        `[DeviceTools] Deferred provisionDevice ${args.operationId} operation failure persistence failed: ` +
          `${errorMessage(error)}`,
        error,
      );
    }
  }

  function keepProvisionDeviceOperationAlive(
    store: ProvisionDeviceOperationStore,
    operationId: string,
    attemptId: string,
    timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">,
  ): { ready: Promise<void>; stop: () => Promise<void> } {
    let stopped = false;
    let timeout: NodeJS.Timeout | undefined;
    let inFlight: Promise<void> | undefined;
    const extend = (): void => {
      if (inFlight) {
        return;
      }
      const refresh = store
        .extend(operationId, attemptId, timer.now() + PROVISION_DEVICE_OPERATION_TTL_MS)
        .then((extended) => {
          if (!extended) {
            logger.debug(
              `[DeviceTools] provisionDevice ${operationId} finalization TTL refresh was superseded.`,
            );
          }
        })
        .catch((error: unknown) => {
          logger.warn(
            `[DeviceTools] Failed to refresh provisionDevice ${operationId} finalization TTL: ` +
              `${errorMessage(error)}`,
            error,
          );
        });
      inFlight = refresh.finally(() => {
        inFlight = undefined;
      });
    };
    const schedule = (): void => {
      timeout = timer.setTimeout(() => {
        if (stopped) {
          return;
        }
        extend();
        schedule();
      }, PROVISION_DEVICE_FINALIZATION_TTL_REFRESH_MS);
    };
    extend();
    const ready = inFlight ?? Promise.resolve();
    schedule();
    return {
      ready,
      stop: () => {
        stopped = true;
        if (timeout) {
          timer.clearTimeout(timeout);
        }
        return inFlight ?? Promise.resolve();
      },
    };
  }

  /**
   * Record that this attempt is about to create the device. A false return
   * means the row was taken over by a newer attempt, so this one must abort
   * before creating anything rather than provisioning behind its replacement.
   */
  async function markProvisionDeviceCreationStarted(
    store: ProvisionDeviceOperationStore,
    operationId: string,
    attemptId: string,
  ): Promise<void> {
    if (!(await store.markDeviceCreationStarted(operationId, attemptId))) {
      throw new ProvisionDeviceOperationSupersededError(operationId);
    }
  }

  async function releaseProvisionDeviceSession(
    result: Record<string, unknown>,
    reason: string,
  ): Promise<void> {
    const persistedSession = getPersistedProvisionDeviceSession(result);
    const daemonState = DaemonState.getInstance();
    if (!persistedSession || !daemonState.isInitialized()) {
      return;
    }
    const sessionManager = daemonState.getSessionManager();
    const session = sessionManager.getSession(persistedSession.sessionId);
    if (
      session?.assignedDevice !== persistedSession.deviceId ||
      session.platform !== persistedSession.platform
    ) {
      return;
    }
    try {
      const releasedDeviceId = await sessionManager.releaseSession(
        persistedSession.sessionId,
        reason,
      );
      if (releasedDeviceId === persistedSession.deviceId) {
        await daemonState
          .getDevicePool()
          .releaseDevice(releasedDeviceId, persistedSession.sessionId);
      }
    } catch (error) {
      logger.warn(
        `[DeviceTools] Failed to release provisionDevice session ${persistedSession.sessionId}: ${error}`,
      );
    }
  }

  /**
   * Creation ownership accumulates across the attempts of one operation. The
   * first attempt's `created` must survive a rebind that merely re-adopts the
   * device it created, and a rebind that genuinely re-created a device that
   * disappeared between attempts must claim ownership instead of inheriting the
   * first attempt's `adopted` — a caller that only deletes what AutoMobile
   * created would otherwise leak it.
   */
  function preserveProvisionDeviceOwnership(
    persisted: Record<string, unknown>,
    refreshed: Record<string, unknown>,
  ): Record<string, unknown> {
    const created = persisted.created === true || refreshed.created === true;
    return {
      ...refreshed,
      created,
      adopted: !created,
    };
  }

  function toProvisionDeviceError(args: ProvisionDeviceArgs, error: unknown): ProvisionDeviceError {
    const knownError = knownProvisionDeviceError(error);
    if (knownError) {
      return knownError;
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
        operationId: cleanupArgs.operationId,
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
        operationId: cleanupArgs.operationId,
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
      operationId: cleanupArgs.operationId,
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
      operationId: cleanupArgs.operationId,
      target: cleanupArgs.target,
      failure: { code, phase: "precondition", message },
    });
  }

  function unresolvedProvisionCleanup(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    createdDevice: DeviceInfo,
    provisionFailure: ProvisionDeviceError,
  ): ProvisionDeviceRollbackError {
    return new ProvisionDeviceRollbackError(provisionFailure, {
      status: "failed",
      operationId: deps.idGenerator.next(),
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
        operationId: rollbackError.cleanup.operationId,
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
    }: ProvisionCleanupOptions,
  ): Promise<ProvisionDeviceRollbackError> {
    const rollbackDeadlineMs = deps.timer.now() + DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS;
    const stableId =
      createdDevice.platform === "android" ? createdDevice.name : createdDevice.deviceId;
    if (!stableId) {
      return unresolvedProvisionCleanup(args, deps, createdDevice, provisionFailure);
    }
    const cleanupArgs: TeardownDeviceArgs = {
      operationId: deps.idGenerator.next(),
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
      await recordLifecycle(lifecycle);
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
      resultTtlMs: TEARDOWN_OPERATION_RESULT_TTL_MS,
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
          operationId: cleanupArgs.operationId,
          target: cleanupArgs.target,
          failure: {
            code: "lifecycle_reservation_lost",
            phase: "precondition",
            message: errorMessage(error),
          },
        }),
      );
    } finally {
      // Rollback is not caller-replayable, so it must not retain operation state.
      cleanupService.dispose();
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
   */
  async function resolveCreatedIosProvisionDeviceRollbackTarget(
    args: ProvisionDeviceArgs,
    deviceManager: PlatformDeviceManager,
  ): Promise<DeviceInfo | undefined> {
    try {
      const discovery = await deviceManager.getDeviceImagesDetailed("ios", {
        bypassIosDeviceListCache: true,
      });
      if (!discovery.succeededPlatforms.has("ios")) {
        logger.warn(
          `[DeviceTools] Cannot roll back iOS simulator '${args.device.name}': identity discovery did not complete.`,
        );
        return undefined;
      }
      return findExactIosProvisionDeviceCandidate(args, discovery.devices);
    } catch (error) {
      logger.warn(
        `[DeviceTools] Failed to resolve the iOS rollback target for '${args.device.name}': ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  async function resolveProvisionDeviceRollbackTarget(
    args: ProvisionDeviceArgs,
    deviceManager: PlatformDeviceManager,
    provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>> | undefined,
    creationStarted: boolean,
    observedRuntimeDevice: BootedDevice | undefined,
  ): Promise<DeviceInfo | undefined> {
    if (!provisioned?.created && !creationStarted) {
      return undefined;
    }
    const createdDevice =
      provisioned?.device ??
      (args.device.platform === "android"
        ? { name: args.device.name, platform: "android" as const, isRunning: false }
        : await resolveCreatedIosProvisionDeviceRollbackTarget(args, deviceManager));
    if (!createdDevice || !observedRuntimeDevice?.deviceId) {
      return createdDevice;
    }
    return { ...createdDevice, deviceId: observedRuntimeDevice.deviceId };
  }

  async function throwProvisionWithoutCreatedDevice(
    provisionFailure: ProvisionDeviceError,
    preserveRetryability: boolean,
    recordLifecycle: RecordProvisionDeviceLifecycle,
  ): Promise<never> {
    if (preserveRetryability) {
      throw provisionFailure;
    }
    const lifecycle: ProvisionDeviceLifecycleOutcome = {
      state: "no_device_created",
      phase: "provisioning",
      reason: provisionDeviceLifecycleReason(provisionFailure),
    };
    await recordLifecycle(lifecycle);
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
      preserveRetryability,
    }: {
      creationStarted: boolean;
      takeLifecycleLease: () => VirtualDeviceLifecycleLease | undefined;
      error: unknown;
      unownedColdBootSettlement: Promise<void> | undefined;
      pendingMutationSettlement: Promise<unknown> | undefined;
      recordLifecycle: RecordProvisionDeviceLifecycle;
      observedRuntimeDevice: BootedDevice | undefined;
      preserveRetryability: boolean;
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
    const createdDevice = await resolveProvisionDeviceRollbackTarget(
      args,
      deviceManager,
      provisioned,
      creationStarted,
      observedRuntimeDevice,
    );
    const provisionFailure = toProvisionDeviceError(args, error);
    if (!createdDevice) {
      return await throwProvisionWithoutCreatedDevice(
        provisionFailure,
        preserveRetryability,
        recordLifecycle,
      );
    }
    // A destructive teardown of this AVD must not race the emulator process the
    // failed attempt is still killing.
    await unownedColdBootSettlement;
    const lifecycleDevice = provisionDeviceLifecycleIdentity(
      args,
      createdDevice,
      observedRuntimeDevice,
    );
    if (!preserveRetryability) {
      await recordLifecycle({
        state: "cleanup_in_progress",
        phase: "cleanup",
        device: lifecycleDevice,
        reason: provisionDeviceLifecycleReason(provisionFailure),
        cleanup: { status: "in_progress", reason: "readiness_timeout" },
      });
    }
    throw await cleanupFailedProvisionDevice(args, deps, createdDevice, provisionFailure, {
      lifecycleLease: takeLifecycleLease(),
      pendingMutationSettlement: pendingMutationSettlement,
      recordLifecycle: preserveRetryability ? undefined : recordLifecycle,
      lifecycleDevice: preserveRetryability ? undefined : lifecycleDevice,
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
    reconcileExistingConfiguration: boolean,
    markDeviceCreationStarted: () => Promise<void>,
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
    let creationStarted = reconcileExistingConfiguration;
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
          reconcileExistingConfiguration: reconcileExistingConfiguration,
          markDeviceCreationStarted: async () => {
            await markDeviceCreationStarted();
            creationStarted = true;
          },
          lifecycleLease: lifecycleLease,
          collectPendingSettlement: (settlement) => {
            settlementState.exactProvisioning = settlement;
          },
          signal: signal,
        },
      );
      const createdByOperation = reconcileExistingConfiguration || provisioned.created;
      await recordLifecycle(prebootProvisionDeviceLifecycle(args, provisioned));
      if (!args.boot) {
        if (provisioned.created) {
          // Device creation is committed. Do not make its response or rollback
          // depend on an advisory resource notification.
          notifyResourcesChangedBestEffort();
        }
        perf.end();
        return buildProvisionDeviceResult(args, provisioned, createdByOperation, perf, undefined);
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
          onBooted: async (device) => {
            observedRuntimeDevice = device;
            await recordLifecycle({
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
      return buildProvisionDeviceResult(args, provisioned, createdByOperation, perf, booted);
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
        preserveRetryability: signal?.aborted === true,
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
      reconcileExistingConfiguration,
      markDeviceCreationStarted,
      lifecycleLease,
      collectPendingSettlement,
      signal,
    }: {
      totalDeadlineMs: number;
      reconcileExistingConfiguration: boolean;
      markDeviceCreationStarted: () => Promise<void>;
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
              reconcileExistingConfiguration,
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
      await onBooted(boot.device);
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
        args.__mcpSessionId ? { mcpSessionId: args.__mcpSessionId } : undefined,
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
    createdByOperation: boolean,
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
      operationId: args.operationId,
      ...(booted?.resources ? { resources: booted.resources } : {}),
      device: projectProvisionedDevice(description),
      requestedSpec: args.device.spec,
      resolvedSpec: provisioned.resolvedSpec,
      displayCutout:
        provisioned.resolvedSpec.displayCutout ??
        classifyDisplayCutout(args.device.platform, provisioned.resolvedSpec.deviceType),
      created: createdByOperation,
      adopted: !createdByOperation,
      lifecycleState: booted ? "ready" : createdByOperation ? "created" : "adopted",
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

  function provisionDeviceErrorResponse(error: unknown, operationId: string) {
    const lifecycle = lifecycleForProvisionResponseError(error);
    const operationOutcome = {
      operationId,
      ...(lifecycle ? { lifecycle } : {}),
    };
    if (error instanceof DaemonHandoffInterruptionError) {
      return createToolErrorResponse(error.code, error.message, {
        ...operationOutcome,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
      });
    }
    if (error instanceof ProvisionDeviceRollbackError) {
      return createToolErrorResponse(error.code, error.message, {
        ...operationOutcome,
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
        ...operationOutcome,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...provisionDeviceDiagnosticFields(error),
        },
      });
    }
    if (error instanceof ProvisionDeviceOperationConflictError) {
      return createToolErrorResponse("operation_conflict", error.message, operationOutcome);
    }
    if (error instanceof ProvisionDeviceOperationFailedError) {
      return createToolErrorResponse(error.errorCode, error.message, {
        ...operationOutcome,
        error: {
          code: error.errorCode,
          message: error.message,
          retryable: error.lifecycle.reason?.retryable ?? false,
          ...provisionDeviceLifecycleDiagnosticFields(error.lifecycle.reason),
        },
      });
    }
    if (error instanceof ProvisionDeviceOperationInProgressError) {
      return createToolErrorResponse("operation_in_progress", error.message, operationOutcome);
    }
    if (error instanceof ProvisionDeviceOperationSupersededError) {
      return createToolErrorResponse("operation_superseded", error.message, operationOutcome);
    }
    return createToolErrorResponse(
      "platform_command_failed",
      errorMessage(error),
      operationOutcome,
    );
  }

  function provisionDeviceDiagnosticFields(error: ProvisionDeviceError) {
    const diagnostics = error.diagnostics;
    return {
      ...(diagnostics.providerCode ? { providerCode: diagnostics.providerCode } : {}),
      ...(diagnostics.readinessPhase ? { readinessPhase: diagnostics.readinessPhase } : {}),
      ...(diagnostics.attempt !== undefined ? { attempt: diagnostics.attempt } : {}),
      ...(diagnostics.incidentId ? { incidentId: diagnostics.incidentId } : {}),
      ...(diagnostics.deviceId ? { deviceId: diagnostics.deviceId } : {}),
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

  function provisionDeviceLifecycleDiagnosticFields(
    reason: ProvisionDeviceLifecycleOutcome["reason"],
  ) {
    if (!reason) {
      return {};
    }
    return {
      ...(reason.providerCode ? { providerCode: reason.providerCode } : {}),
      ...(reason.readinessPhase ? { readinessPhase: reason.readinessPhase } : {}),
      ...(reason.attempt !== undefined ? { attempt: reason.attempt } : {}),
      ...(reason.incidentId ? { incidentId: reason.incidentId } : {}),
      ...(reason.deviceId ? { deviceId: reason.deviceId } : {}),
      ...(reason.resourceDrift ? { resourceDrift: reason.resourceDrift } : {}),
      ...(reason.runtimeCompatibility ? { runtimeCompatibility: reason.runtimeCompatibility } : {}),
      ...(reason.daemonBuild ? { daemonBuild: reason.daemonBuild } : {}),
    };
  }

  return (input: ProvisionDeviceArgs, progress?: ProgressCallback, signal?: AbortSignal) =>
    runWithAutolockPolicy(getDeviceToolsDependencies().env, () =>
      provisionDeviceHandler(input, progress, signal),
    );
}
