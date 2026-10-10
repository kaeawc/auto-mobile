import { DaemonState } from "../daemon/daemonState";
import { AndroidCtrlProxyManager } from "../ctrlProxy/CtrlProxyManager";
import { getAbortSignal } from "../utils/AbortContext";
import { DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS } from "../utils/deviceTimeouts";
import {
  DeviceTeardownDeadlineError,
  type DeviceTeardownPhase,
  type DeviceTeardownService,
  type DeviceTeardownWorkflow,
} from "../devices/deviceTeardownService";
import {
  selectorLifecycleIdentity,
  type VirtualDeviceLifecycleLease,
} from "../devices/virtualDeviceLifecycleCoordinator";
import { logger } from "../utils/logger";
import { InputDeviceOwnedError } from "../daemon/inputDeviceOwnership";
import { DeviceOwnedByOtherDaemonError } from "../daemon/deviceAcquisitionRefusals";
import type { ProgressCallback } from "./toolRegistry";
import {
  assertLifecycleCallerHoldsDevice,
  assertLifecycleTargetNotHeldByOtherDaemon,
  LIFECYCLE_TOOL_FOREIGN_DAEMON_REMEDY,
  assertLifecycleCallerNotOnForeignManagedSlot,
  lifecycleRequester,
  type LifecycleRequester,
} from "./lifecycleDeviceOwnership";
import { DeviceAssignedToManagedSlotError } from "../daemon/managedSlots/managedSlotRefusal";
import {
  DEVICE_SHUTDOWN_TIMEOUT_MS,
  PooledAvdIdentityError,
  capturePooledAvdIdentity,
  checkForRestartedTeardownTarget,
  createTeardownFailureResponse,
  createTeardownVerificationDeadlineFailure,
  destroyTeardownTarget,
  finalizeTeardownEviction,
  getDeviceTeardownService,
  getDeviceToolsDependencies,
  isProvisionDeviceCallerAbort,
  pooledAvdKillIdentity,
  pooledAvdNameRefusalMessage,
  reserveStableDeviceLifecycle,
  resolveKillDeviceStableTarget,
  resolveTeardownTarget,
  retireStoppedTeardownOwnership,
  stopSegmentedVideoRecordingsBeforeDestroy,
  teardownDeadlineDevice,
  verifyTeardownAbsence,
} from "./deviceTools";
import {
  createKillDeviceResponse,
  shutdownDevice,
  shutdownTimeoutError,
} from "./deviceToolsShutdown";
import type {
  DeviceToolsDependencies,
  KillDeviceArgs,
  TeardownContext,
  TeardownDeviceArgs,
  TeardownResolvedTarget,
  TeardownToolResponse,
} from "./deviceTools";

function teardownDeadlineFailure(
  phase: DeviceTeardownPhase,
  state:
    | {
        context: TeardownContext;
        target: TeardownResolvedTarget;
        lastVerificationFailure?: TeardownToolResponse;
      }
    | undefined,
  args: TeardownDeviceArgs,
  timeoutMs: number,
): TeardownToolResponse | Error {
  if (phase === "verification" && state) {
    return createTeardownVerificationDeadlineFailure(
      state.context,
      state.target,
      state.lastVerificationFailure,
    );
  }
  return shutdownTimeoutError(
    state?.context.deadlineDevice ?? teardownDeadlineDevice(args),
    phase === "precondition"
      ? "waiting for teardown target discovery or stable device lifecycle reservation"
      : `teardown ${phase} did not complete`,
    timeoutMs,
  );
}

type TeardownState = {
  context: TeardownContext;
  target: TeardownResolvedTarget;
  androidManager?: AndroidCtrlProxyManager;
  earlyResponse?: TeardownToolResponse;
  lastVerificationFailure?: TeardownToolResponse;
};

/**
 * Refuse to tear down a booted device another session (#10785) or another live daemon (#11200)
 * holds, as a typed precondition failure so the teardown is never accepted. Returns undefined
 * when the caller may proceed.
 */
async function teardownOwnershipRefusal(
  args: TeardownDeviceArgs,
  target: TeardownResolvedTarget,
  requester: LifecycleRequester | undefined,
): Promise<TeardownToolResponse | undefined> {
  if (!requester || !target.wasBooted) {
    return undefined;
  }
  try {
    assertLifecycleCallerHoldsDevice({
      toolName: "deleteDevice",
      device: target.bootedDevice,
      requester,
      force: args.force ?? false,
      stableIds: [args.target.stableId],
    });
    await assertLifecycleTargetNotHeldByOtherDaemon({
      toolName: "deleteDevice",
      device: target.bootedDevice,
      force: args.force ?? false,
    });
    return undefined;
  } catch (error) {
    if (error instanceof DeviceAssignedToManagedSlotError) {
      return managedSlotTeardownRefusal(args, error, target.device);
    }
    if (
      !(error instanceof InputDeviceOwnedError || error instanceof DeviceOwnedByOtherDaemonError)
    ) {
      throw error;
    }
    return createTeardownFailureResponse(
      args,
      "precondition",
      error.code,
      error.message,
      target.device,
    );
  }
}

/** deleteDevice's typed precondition failure for a device a managed slot holds (#11174). */
function managedSlotTeardownRefusal(
  args: TeardownDeviceArgs,
  error: DeviceAssignedToManagedSlotError,
  resolved?: TeardownResolvedTarget["device"],
): TeardownToolResponse {
  const { code, retryable, ...evidence } = error.toPayload();
  return createTeardownFailureResponse(
    args,
    "precondition",
    String(code),
    error.message,
    resolved,
    { ...evidence, retryable },
  );
}

/**
 * Refuse deleteDevice of a device a managed slot holds before any teardown work, stopped or not:
 * an idle assigned AVD has no session, so only the registry knows it is taken. Internal rollbacks
 * (no requester) are not generic callers and skip it.
 */
async function managedSlotDeleteRefusal(
  args: TeardownDeviceArgs,
  requester: LifecycleRequester | undefined,
): Promise<{ response: TeardownToolResponse } | undefined> {
  if (!requester) {
    return undefined;
  }
  try {
    await assertLifecycleCallerNotOnForeignManagedSlot({
      toolName: "deleteDevice",
      device: { deviceId: args.target.stableId, platform: args.target.platform },
      requester,
    });
    return undefined;
  } catch (error) {
    if (error instanceof DeviceAssignedToManagedSlotError) {
      return { response: managedSlotTeardownRefusal(args, error) };
    }
    throw error;
  }
}

/**
 * killDevice's entry check: a managed slot's device stops only for that slot's execution, force or
 * not (#11174); a device another session holds stops only for its holder or an explicit force
 * (#10785), and one another live daemon holds only with an explicit force (#11200).
 */
async function assertKillDeviceCaller(args: KillDeviceArgs): Promise<void> {
  await assertLifecycleCallerNotOnForeignManagedSlot({
    toolName: "killDevice",
    device: args.device,
    requester: lifecycleRequester(args),
    stableIds: [args.device.name],
  });
  assertLifecycleCallerHoldsDevice({
    toolName: "killDevice",
    device: args.device,
    requester: lifecycleRequester(args),
    force: args.force ?? false,
    stableIds: [args.device.name],
  });
  await assertLifecycleTargetNotHeldByOtherDaemon({
    toolName: "killDevice",
    device: args.device,
    force: args.force ?? false,
  });
}

function createDeleteDeviceWorkflow(
  args: TeardownDeviceArgs,
  deps: DeviceToolsDependencies,
  deadlineMs: number,
  timeoutMs: number,
  requester: LifecycleRequester | undefined,
): DeviceTeardownWorkflow<TeardownState, "accepted" | "not_required", TeardownToolResponse> {
  return {
    resolve: async (requestAbortSignal, lifecycleLease) => {
      const context: TeardownContext = {
        args,
        dependencies: deps,
        deviceManager: deps.deviceManagerFactory(),
        requestAbortSignal,
        deadlineDevice: teardownDeadlineDevice(args),
        deadlineMs,
        timeoutMs,
        cancelOnRequestAbort: args.cancellationPolicy === "cancel-on-request-abort",
        lifecycleLease,
        mode: args.force === true ? "serial-only" : "named",
        initialScan: { serials: new Set(), pooledEntries: [] },
      };
      const resolution =
        (await managedSlotDeleteRefusal(args, requester)) ?? (await resolveTeardownTarget(context));
      if ("response" in resolution) {
        return { response: resolution.response };
      }
      const ownershipRefusal = await teardownOwnershipRefusal(args, resolution.target, requester);
      if (ownershipRefusal) {
        return { response: ownershipRefusal };
      }
      const runtime = resolution.target.wasBooted ? resolution.target.bootedDevice : undefined;
      const androidManager =
        runtime?.platform === "android"
          ? AndroidCtrlProxyManager.getExistingInstance(runtime.deviceId)
          : undefined;
      return { target: { context, target: resolution.target, androidManager } };
    },
    stop: async (state, requestAbortSignal, retainLeaseUntil) => {
      const { context, target } = state;
      let stop: "accepted" | "not_required" = "not_required";
      if (target.wasBooted) {
        const stopped = await shutdownDevice(
          {
            device: target.bootedDevice,
            timer: deps.timer,
            deadlineMs: context.deadlineMs,
            requestAbortSignal,
            stopPerformanceMonitoring: deps.stopPerformanceMonitoring,
          },
          deps,
          "deleteDevice",
          {
            strictDeadline: true,
            timeoutMs: context.timeoutMs,
            retainLifecycleUntil: retainLeaseUntil,
            pooledAvdIdentity: {
              capture: target.pooledAvdCapture,
              force: args.force ?? false,
            },
            assertHolder: requester
              ? () =>
                  assertLifecycleCallerHoldsDevice({
                    toolName: "deleteDevice",
                    device: target.bootedDevice,
                    requester,
                    force: args.force ?? false,
                    stableIds: [args.target.stableId],
                  })
              : undefined,
            foreignClaim: requester
              ? {
                  toolName: "deleteDevice",
                  force: args.force ?? false,
                  remedy: LIFECYCLE_TOOL_FOREIGN_DAEMON_REMEDY,
                }
              : undefined,
          },
        );
        stop = stopped.alreadyStoppedMessage ? "not_required" : "accepted";
      } else {
        await stopSegmentedVideoRecordingsBeforeDestroy(context, target);
        await retireStoppedTeardownOwnership(context, target);
      }

      const restarted = await checkForRestartedTeardownTarget(context, target, "stop");
      if (restarted) {
        state.earlyResponse = restarted;
      }
      return stop;
    },
    destroy: async (state, _requestAbortSignal, retainLeaseUntil) => {
      if (state.earlyResponse) {
        return;
      }
      const { context, target } = state;
      await destroyTeardownTarget(context, target, retainLeaseUntil, () => {
        void finalizeTeardownEviction(context, target, state.androidManager);
      });
      await finalizeTeardownEviction(context, target, state.androidManager);
    },
    verify: async (state, stop) => {
      if (state.earlyResponse) {
        return state.earlyResponse;
      }
      return await verifyTeardownAbsence(state.context, state.target, stop, (failure) => {
        state.lastVerificationFailure = failure;
      });
    },
    failure: (phase: DeviceTeardownPhase, error, state) => {
      if (error instanceof DeviceTeardownDeadlineError) {
        const mapped = teardownDeadlineFailure(phase, state, args, timeoutMs);
        if (!(mapped instanceof Error)) {
          return mapped;
        }
        error = mapped;
      }
      const effectiveError =
        phase === "precondition" &&
        error instanceof Error &&
        error.message.startsWith("Timed out waiting to teardown")
          ? shutdownTimeoutError(
              teardownDeadlineDevice(args),
              "waiting for stable device lifecycle reservation",
              timeoutMs,
            )
          : error;
      logger.warn(
        `[DeviceTools] teardown failed during ${phase} ` +
          `for ${args.target.platform}:${args.target.stableId}: ${effectiveError}`,
        effectiveError,
      );
      if (effectiveError instanceof DeviceAssignedToManagedSlotError) {
        // A managed slot took the device between the entry check and the shutdown reservation.
        return managedSlotTeardownRefusal(args, effectiveError, state?.target.device);
      }
      return createTeardownFailureResponse(
        args,
        phase,
        // The last-moment identity check refuses a target this daemon
        // cannot tie to the runtime; that is an identity outcome, not a
        // generic operation failure (#6863 review).
        effectiveError instanceof PooledAvdIdentityError
          ? "target_identity_unresolved"
          : effectiveError instanceof InputDeviceOwnedError
            ? // Ownership was lost between the entry check and the shutdown reservation.
              effectiveError.code
            : "operation_failed",
        String(effectiveError instanceof Error ? effectiveError.message : effectiveError),
        state?.target.device,
      );
    },
  };
}

export function createLifecycleHandlers() {
  const killDeviceHandler = async (
    args: KillDeviceArgs,
    _progress?: ProgressCallback,
    abortSignal?: AbortSignal,
  ) => {
    await assertKillDeviceCaller(args);
    const deps = getDeviceToolsDependencies();
    const requestAbortSignal = abortSignal ?? getAbortSignal();
    const deadlineMs = deps.timer.now() + DEVICE_SHUTDOWN_TIMEOUT_MS;
    const daemonState = DaemonState.getInstance();
    const devicePool = daemonState.isInitialized() ? daemonState.getDevicePool() : undefined;
    // Preflight: if this target's AVD name comes from the pool rather than from
    // the runtime, pin the label to its epoch. The runtime is made to confirm it
    // immediately before the platform kill, not here (#6863 review).
    const pooledAvdCapture = capturePooledAvdIdentity(args.device, devicePool, {
      timer: deps.timer,
      deadlineMs,
      signal: requestAbortSignal,
    });
    if (pooledAvdCapture.kind === "refusal") {
      throw new PooledAvdIdentityError(
        pooledAvdNameRefusalMessage(args.device, pooledAvdCapture.refusal),
      );
    }
    const stableTarget = resolveKillDeviceStableTarget(args.device, devicePool);
    const lifecycleLease = stableTarget
      ? await reserveStableDeviceLifecycle(stableTarget, args.device, deps.timer, deadlineMs, {
          requestAbortSignal: requestAbortSignal,
          timeoutError: undefined,
          operation: "shutdown",
          coordinator: deps.lifecycleCoordinator,
        })
      : await deps.lifecycleCoordinator.reserve(
          selectorLifecycleIdentity(args.device.platform, { deviceId: args.device.deviceId }),
          { operation: "shutdown", deadlineMs, signal: requestAbortSignal },
        );
    const signals = [requestAbortSignal, lifecycleLease.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    let retainLifecycleLease = false;
    const retainLifecycleUntil = (operation: Promise<unknown>): void => {
      retainLifecycleLease = true;
      void operation.then(
        () => lifecycleLease.release(),
        () => lifecycleLease.release(),
      );
    };
    try {
      const result = await shutdownDevice(
        {
          device: args.device,
          timer: deps.timer,
          deadlineMs,
          requestAbortSignal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
          stopPerformanceMonitoring: deps.stopPerformanceMonitoring,
        },
        deps,
        "killDevice",
        {
          strictDeadline: false,
          timeoutMs: DEVICE_SHUTDOWN_TIMEOUT_MS,
          retainLifecycleUntil,
          pooledAvdIdentity: pooledAvdKillIdentity(pooledAvdCapture, args.force ?? false),
          // The entry check predates the lease wait; re-check under the assignment mutex.
          assertHolder: () =>
            assertLifecycleCallerHoldsDevice({
              toolName: "killDevice",
              device: args.device,
              requester: lifecycleRequester(args),
              force: args.force ?? false,
              stableIds: [args.device.name],
            }),
          foreignClaim: {
            toolName: "killDevice",
            force: args.force ?? false,
            remedy: LIFECYCLE_TOOL_FOREIGN_DAEMON_REMEDY,
          },
        },
      );
      return createKillDeviceResponse(args, result.timing, result.alreadyStoppedMessage);
    } finally {
      if (!retainLifecycleLease) {
        lifecycleLease.release();
      }
    }
  };

  async function executeDeleteDevice(
    args: TeardownDeviceArgs,
    deps: DeviceToolsDependencies,
    callerSignal: AbortSignal | undefined,
    teardownService: DeviceTeardownService,
    lifecycleLease?: VirtualDeviceLifecycleLease,
    /** The deleteDevice caller; omitted by internal rollbacks of a device the caller created. */
    requester?: LifecycleRequester,
  ): Promise<TeardownToolResponse> {
    const timeoutMs = args.timeoutMs ?? DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS;
    const deadlineMs = deps.timer.now() + timeoutMs;
    try {
      return await teardownService.teardown<
        TeardownState,
        "accepted" | "not_required",
        TeardownToolResponse
      >(
        {
          identity: args.target,
          deadlineMs,
          callerSignal,
          cancellationPolicy: args.cancellationPolicy ? "cancel-on-caller-abort" : undefined,
          lifecycleLease,
        },
        createDeleteDeviceWorkflow(args, deps, deadlineMs, timeoutMs, requester),
      );
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (isProvisionDeviceCallerAbort(error, callerSignal)) {
        // Caller cancellation ends only this wait; the accepted teardown continues independently.
        logger.debug(
          `[DeviceTools] teardown caller stopped waiting for ${args.target.platform}:${args.target.stableId}: ${message}`,
        );
        return createTeardownFailureResponse(args, "precondition", "operation_cancelled", message);
      }
      logger.warn(
        `[DeviceTools] teardown failed for ${args.target.platform}:${args.target.stableId}: ${message}`,
        error,
      );
      return createTeardownFailureResponse(args, "precondition", "operation_failed", message);
    }
  }

  const deleteDeviceHandler = async (
    args: TeardownDeviceArgs,
    _progress?: ProgressCallback,
    abortSignal?: AbortSignal,
  ) => {
    const deps = getDeviceToolsDependencies();
    return await executeDeleteDevice(
      args,
      deps,
      abortSignal ?? getAbortSignal(),
      getDeviceTeardownService(deps),
      undefined,
      lifecycleRequester(args),
    );
  };

  return { killDeviceHandler, executeDeleteDevice, deleteDeviceHandler };
}
