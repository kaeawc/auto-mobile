import { deleteAppleTvDevice } from "./deviceToolsAppleTvDelete";
import type { DeleteDeviceOptions } from "../features/deviceLifecycle/teardown/teardownContracts";
import type { RestartStopIdentity } from "../daemon/devicePool";
import { BootedDeviceDiscoveryIncompleteError } from "../models/BootedDeviceDiscoveryIncompleteError";
import type { BootedDevice } from "../models";
import {
  deleteWatchDevice,
  isWatchTeardownRequest,
  type RegisteredTeardownArgs,
} from "./deviceToolsWatchDelete";
import type { DaemonStateLike } from "../daemon/daemonState";
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
import { errorMessage } from "../utils/describeUnknownError";
import { hasSimctlTimeoutCause } from "../utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import {
  BootConcurrencyGate,
  type BootConcurrencyPool,
} from "../features/iosSimFleet/BootConcurrencyGate";
import { isTypedToolRefusal, shapeToolCallError } from "../daemon/shapeToolCallError";
import { typedRefusalFields } from "../models/typedRefusalFields";
import { InputDeviceOwnedError } from "../daemon/inputDeviceOwnership";
import { EmulatorTeardownEscalationError } from "../features/deviceLifecycle/teardown/stuckEmulatorEscalation";
import { DeviceOwnedByOtherDaemonError } from "../models/deviceAcquisitionRefusals";
import type { ProgressCallback } from "./toolRegistry";
import {
  assertLifecycleCallerHoldsDevice,
  assertLifecycleCallerMayStopRestartReservation,
  assertLifecycleTargetNotHeldByOtherDaemon,
  LIFECYCLE_TOOL_FOREIGN_DAEMON_REMEDY,
  assertLifecycleCallerNotOnForeignBinding,
  resolveRestartStopIdentity,
} from "./lifecycleDeviceOwnership";
import {
  lifecycleRequester,
  type LifecycleRequester,
} from "../features/deviceLifecycle/lifecycleRequester";
import { DeviceAssignedToBindingError } from "../daemon/sessionBroker/provisioning/refusal";
import {
  commitStoppedRestartHold,
  createKillDeviceResponse,
  shutdownDevice,
} from "./deviceToolsShutdown";
import {
  DEVICE_SHUTDOWN_TIMEOUT_MS,
  DeviceToolsDependencies,
  KillDeviceArgs,
  PooledAvdIdentityError,
  TeardownContext,
  TeardownDeviceArgs,
  TeardownResolvedTarget,
  TeardownToolResponse,
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
  refuseLiveStoppedAndroidTarget,
  shutdownTimeoutError,
  stopSegmentedVideoRecordingsBeforeDestroy,
  teardownDeadlineDevice,
  verifyTeardownAbsence,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import { assertRequestNotTvos } from "./applePlatformToolSupport";

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
  commitRestartHoldStop?: () => void | Promise<void>;
  stopIdentity?: RestartStopIdentity;
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
  stopIdentity?: RestartStopIdentity,
): Promise<TeardownToolResponse | undefined> {
  if (!requester) {
    return undefined;
  }
  try {
    const assertOwnership = target.wasBooted
      ? assertLifecycleCallerHoldsDevice
      : assertLifecycleCallerMayStopRestartReservation;
    assertOwnership({
      checkRestartHold: true,
      toolName: "deleteDevice",
      device: target.wasBooted
        ? target.bootedDevice
        : { deviceId: args.target.stableId, platform: args.target.platform },
      requester,
      force: args.force ?? false,
      stableIds: [args.target.stableId],
      stopIdentity,
    });
    if (target.wasBooted) {
      await assertLifecycleTargetNotHeldByOtherDaemon({
        toolName: "deleteDevice",
        device: target.bootedDevice,
        force: args.force ?? false,
      });
    }
    return undefined;
  } catch (error) {
    const refusal = typedTeardownRefusal(args, error, target.device);
    if (!refusal || !isTeardownOwnershipRefusal(error)) {
      throw error;
    }
    logger.warn("[DeviceTools] deleteDevice stop admission refused", error);
    return refusal;
  }
}

function isTeardownOwnershipRefusal(error: unknown): boolean {
  return (
    error instanceof DeviceAssignedToBindingError ||
    error instanceof InputDeviceOwnedError ||
    error instanceof DeviceOwnedByOtherDaemonError ||
    error instanceof BootedDeviceDiscoveryIncompleteError
  );
}

/** Wait hint for a delete that timed out in `simctl`; CoreSimulator drains a burst in seconds. */
export const SIMCTL_TIMEOUT_RETRY_AFTER_MS = 5_000;
/**
 * Simultaneous iOS deleteDevice workflows. Each one issues several `simctl list` and shutdown
 * commands, and `simctl` serializes behind CoreSimulator, so a 31-way burst timed them out and
 * starved heartbeats (#15308); the rest queue.
 */
export const IOS_DELETE_CONCURRENCY = 4;

/**
 * Maps a typed refusal to deleteDevice's failure with the same `code`, `retryable`, `retryAfterMs`
 * and evidence killDevice's thrown path gives it. The fields come from `shapeToolCallError`'s
 * payload so the two tools cannot drift; an untyped error returns undefined.
 */
export function typedTeardownRefusal(
  args: TeardownDeviceArgs,
  error: unknown,
  resolved?: TeardownResolvedTarget["device"],
  phase: "precondition" | "stop" | "destroy" | "verification" = "precondition",
): TeardownToolResponse | undefined {
  if (error instanceof EmulatorTeardownEscalationError) {
    // Soft retries and the SIGTERM/SIGKILL escalation both ran: a caller (the session broker's
    // journal) must be able to tell this terminal failure from an ordinary retryable one (#14018).
    return createTeardownFailureResponse(args, phase, error.code, {
      message: error.message,
      resolved,
      details: {
        retryable: error.retryable,
        reason: error.reason,
        serial: error.serial,
        softAttempts: error.softAttempts,
        ...(error.pid !== undefined ? { pid: error.pid } : {}),
      },
    });
  }
  if (hasSimctlTimeoutCause(error)) {
    // `simctl` queues behind CoreSimulator under a delete burst: the command never ran to a
    // verdict, so the same delete can be retried (#15308).
    return createTeardownFailureResponse(args, phase, "operation_failed", {
      message: errorMessage(error),
      resolved,
      details: {
        retryable: true,
        retryAfterMs: SIMCTL_TIMEOUT_RETRY_AFTER_MS,
        reason: "simctl_timeout",
      },
    });
  }
  if (!isTypedToolRefusal(error)) {
    return undefined;
  }
  // A boot or shutdown timeout is typed for startDevice/killDevice (#11548), but a teardown
  // deadline stays the `operation_failed` failure it always reported; typing it is a separate
  // wire decision.
  if (typedRefusalFields(error)?.code === "timeout") {
    return undefined;
  }
  const wire = JSON.parse(
    shapeToolCallError(error, { toolName: "deleteDevice", source: "MCP" }).content[0].text,
  ) as Record<string, unknown>;
  const { code, error: message, ...fields } = wire;
  if (typeof code !== "string" || typeof message !== "string") {
    return undefined;
  }
  delete fields.success;
  return createTeardownFailureResponse(args, phase, code, { message, resolved, details: fields });
}

/**
 * Refuse deleteDevice of a device a broker binding holds before any teardown work, stopped or not:
 * an idle assigned AVD has no session, so only the registry knows it is taken. Internal rollbacks
 * (no requester) are not generic callers and skip it.
 */
async function bindingDeleteRefusal(
  args: TeardownDeviceArgs,
  requester: LifecycleRequester | undefined,
): Promise<{ response: TeardownToolResponse } | undefined> {
  if (!requester) {
    return undefined;
  }
  try {
    await assertLifecycleCallerNotOnForeignBinding({
      toolName: "deleteDevice",
      device: { deviceId: args.target.stableId, platform: args.target.platform },
      requester,
    });
    return undefined;
  } catch (error) {
    if (error instanceof DeviceAssignedToBindingError) {
      const response = typedTeardownRefusal(args, error);
      if (response) {
        return { response };
      }
    }
    throw error;
  }
}

/**
 * killDevice's entry check: a broker binding's device stops only for that binding's execution, force or
 * not (#11174); a device another session holds stops only for its holder or an explicit force
 * (#10785), and one another live daemon holds only with an explicit force (#11200).
 */
async function assertKillDeviceCaller(
  args: KillDeviceArgs,
  deps: DeviceToolsDependencies,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<RestartStopIdentity | undefined> {
  await assertLifecycleCallerNotOnForeignBinding({
    toolName: "killDevice",
    device: args.device,
    requester: lifecycleRequester(args),
    stableIds: [args.device.name],
  });
  const stopIdentity = await resolveRestartStopIdentity({
    device: args.device,
    dependencies: deps,
    deadlineMs,
    signal,
  });
  assertLifecycleCallerHoldsDevice({
    checkRestartHold: true,
    toolName: "killDevice",
    device: args.device,
    requester: lifecycleRequester(args),
    force: args.force ?? false,
    stableIds: [args.device.name],
    stopIdentity,
  });
  await assertLifecycleTargetNotHeldByOtherDaemon({
    toolName: "killDevice",
    device: args.device,
    force: args.force ?? false,
  });
  return stopIdentity;
}

/**
 * deleteDevice's caller checks for an Apple Watch simulator (#15882): the same broker-binding,
 * session-holder and other-daemon refusals killDevice applies, named for deleteDevice.
 */
export async function assertWatchDeleteCaller(
  device: BootedDevice,
  args: object,
  force: boolean,
): Promise<void> {
  const requester = lifecycleRequester(args);
  await assertLifecycleCallerNotOnForeignBinding({
    toolName: "deleteDevice",
    device,
    requester,
    stableIds: [device.deviceId],
  });
  assertLifecycleCallerHoldsDevice({
    checkRestartHold: true,
    toolName: "deleteDevice",
    device,
    requester,
    force,
    stableIds: [device.deviceId],
    stopIdentity: undefined,
  });
  await assertLifecycleTargetNotHeldByOtherDaemon({ toolName: "deleteDevice", device, force });
}

type TeardownStopIdentities = Map<string, RestartStopIdentity | undefined>;

interface PreLeaseTeardown {
  args: TeardownDeviceArgs;
  deps: DeviceToolsDependencies;
  deadlineMs: number;
  timeoutMs: number;
  requestAbortSignal: AbortSignal | undefined;
  stopIdentities: TeardownStopIdentities;
}

/** Every deleteDevice refusal that must precede the teardown lease reservation. */
async function preLeaseRefusal(
  pre: PreLeaseTeardown,
  requester: LifecycleRequester | undefined,
  lifecycleLease: VirtualDeviceLifecycleLease | undefined,
): Promise<TeardownToolResponse | undefined> {
  const slotRefusal = await bindingDeleteRefusal(pre.args, requester);
  return slotRefusal
    ? slotRefusal.response
    : await preLeaseHolderRefusal(pre, requester, lifecycleLease);
}

/**
 * deleteDevice's ownership refusal before the teardown lease is reserved: reserving it aborts the
 * current lease holder, which a refused delete must never do. Resolution is read-only without a
 * lease; a target that does not resolve here is left to the workflow's own resolution.
 */
async function preLeaseHolderRefusal(
  { args, deps, deadlineMs, timeoutMs, requestAbortSignal, stopIdentities }: PreLeaseTeardown,
  requester: LifecycleRequester | undefined,
  lifecycleLease: VirtualDeviceLifecycleLease | undefined,
): Promise<TeardownToolResponse | undefined> {
  // An already-aborted caller is left to the teardown service's own cancellation path.
  if (!requester || lifecycleLease || requestAbortSignal?.aborted) {
    return undefined;
  }
  const context: TeardownContext = {
    args,
    dependencies: deps,
    deviceManager: deps.deviceManagerFactory(),
    requestAbortSignal,
    deadlineDevice: teardownDeadlineDevice(args),
    deadlineMs,
    timeoutMs,
    cancelOnRequestAbort: args.cancellationPolicy === "cancel-on-request-abort",
    mode: args.force === true ? "serial-only" : "named",
    initialScan: { serials: new Set(), pooledEntries: [] },
  };
  const resolution = await resolveTeardownTarget(context);
  if ("response" in resolution) {
    return undefined;
  }
  const stopIdentity = await resolveTeardownStopIdentity(
    context,
    resolution.target,
    stopIdentities,
  );
  return await teardownOwnershipRefusal(args, resolution.target, requester, stopIdentity);
}

/** Per-call cache reuses serial evidence across teardown's read-only target resolutions. */
async function resolveTeardownStopIdentity(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  identities: TeardownStopIdentities,
): Promise<RestartStopIdentity | undefined> {
  const device = target.wasBooted
    ? target.bootedDevice
    : { ...target.device, deviceId: context.args.target.stableId };
  const key = `${device.platform}:${target.wasBooted}:${device.deviceId}`;
  if (!identities.has(key)) {
    identities.set(
      key,
      await resolveRestartStopIdentity({
        device,
        dependencies: context.dependencies,
        deadlineMs: context.deadlineMs,
        signal: context.requestAbortSignal,
        stoppedStableId: target.wasBooted
          ? undefined
          : target.device.platform === "android"
            ? target.device.name
            : target.device.deviceId,
      }),
    );
  }
  return identities.get(key);
}

/** Stopped image destruction captures the stable target before any platform mutation. */
function captureStoppedImageRestartHold(
  args: TeardownDeviceArgs,
  requester: LifecycleRequester | undefined,
  daemonState: Pick<DaemonStateLike, "isInitialized" | "getDevicePool">,
  stopIdentity?: RestartStopIdentity,
): (() => void | Promise<void>) | undefined {
  if (!requester || !daemonState.isInitialized()) {
    return undefined;
  }
  return daemonState
    .getDevicePool()
    .releaseDeviceRestartReservationForStop(args.target.stableId, requester.sessionUuid, {
      mcpSessionId: requester.mcpSessionId,
      platform: args.target.platform,
      stableIds: [args.target.stableId],
      stopIdentity,
    });
}

async function destroyDeleteDeviceTarget(
  state: TeardownState,
  args: TeardownDeviceArgs,
  requester: LifecycleRequester | undefined,
  retainLeaseUntil: (operation: Promise<unknown>) => void,
): Promise<void> {
  if (state.earlyResponse) {
    return;
  }
  const { context, target } = state;
  if (!target.wasBooted) {
    const refusal = await teardownOwnershipRefusal(args, target, requester, state.stopIdentity);
    if (refusal) {
      state.earlyResponse = refusal;
      return;
    }
    state.commitRestartHoldStop = captureStoppedImageRestartHold(
      args,
      requester,
      context.dependencies.daemonState,
      state.stopIdentity,
    );
  }
  await destroyTeardownTarget(context, target, retainLeaseUntil, () => {
    void finalizeTeardownEviction(context, target, state.androidManager);
  });
  await finalizeTeardownEviction(context, target, state.androidManager);
}

async function verifyDeleteDeviceTarget(
  state: TeardownState,
  stop: "accepted" | "not_required",
  deps: DeviceToolsDependencies,
): Promise<TeardownToolResponse> {
  if (state.earlyResponse) {
    return state.earlyResponse;
  }
  const response = await verifyTeardownAbsence(state.context, state.target, stop, (failure) => {
    state.lastVerificationFailure = failure;
  });
  if ("structuredContent" in response) {
    await commitStoppedRestartHold(
      { device: state.context.deadlineDevice, deadlineMs: state.context.deadlineMs },
      deps,
      state.commitRestartHoldStop,
      state.context.timeoutMs,
    );
  }
  return response;
}

async function prepareStoppedTeardownTarget(
  context: TeardownContext,
  target: TeardownResolvedTarget,
): Promise<TeardownToolResponse | undefined> {
  const refusal = await refuseLiveStoppedAndroidTarget(context, target);
  if (refusal) {
    return refusal;
  }
  await stopSegmentedVideoRecordingsBeforeDestroy(context, target);
  await retireStoppedTeardownOwnership(context, target);
  return undefined;
}

/**
 * A delete's caller and private evidence, plus the stop identities its workflow records and the
 * teardown timeout it reports.
 */
type DeleteDeviceWorkflowOptions = Omit<DeleteDeviceOptions, "lifecycleLease"> & {
  timeoutMs: number;
  stopIdentities: TeardownStopIdentities;
};

function createDeleteDeviceWorkflow(
  args: TeardownDeviceArgs,
  deps: DeviceToolsDependencies,
  deadlineMs: number,
  { timeoutMs, stopIdentities, requester, internal }: DeleteDeviceWorkflowOptions,
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
        unlaunchedCreatedAvd: internal?.unlaunchedCreatedAvd,
        mode: args.force === true ? "serial-only" : "named",
        initialScan: { serials: new Set(), pooledEntries: [] },
      };
      // Re-check under the lease: a broker binding may have taken the device since the entry check.
      const resolution =
        (await bindingDeleteRefusal(args, requester)) ?? (await resolveTeardownTarget(context));
      if ("response" in resolution) {
        return { response: resolution.response };
      }
      const stopIdentity = await resolveTeardownStopIdentity(
        context,
        resolution.target,
        stopIdentities,
      );
      const ownershipRefusal = await teardownOwnershipRefusal(
        args,
        resolution.target,
        requester,
        stopIdentity,
      );
      if (ownershipRefusal) {
        return { response: ownershipRefusal };
      }
      const runtime = resolution.target.wasBooted ? resolution.target.bootedDevice : undefined;
      const androidManager =
        runtime?.platform === "android"
          ? AndroidCtrlProxyManager.getExistingInstance(runtime.deviceId)
          : undefined;
      return { target: { context, target: resolution.target, androidManager, stopIdentity } };
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
            stoppingSessionUuid: requester?.sessionUuid,
            stoppingMcpSessionId: requester?.mcpSessionId,
            stableIds: [args.target.stableId],
            stopIdentity: state.stopIdentity,
            retainLifecycleUntil: retainLeaseUntil,
            pooledAvdIdentity: {
              capture: target.pooledAvdCapture,
              force: args.force ?? false,
            },
            assertHolder: requester
              ? (stopIdentity = state.stopIdentity) =>
                  assertLifecycleCallerHoldsDevice({
                    checkRestartHold: true,
                    toolName: "deleteDevice",
                    device: target.bootedDevice,
                    requester,
                    force: args.force ?? false,
                    stableIds: [args.target.stableId],
                    stopIdentity,
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
        state.earlyResponse = await prepareStoppedTeardownTarget(context, target);
      }
      state.earlyResponse ??= await checkForRestartedTeardownTarget(context, target, "stop");
      return stop;
    },
    destroy: async (state, _requestAbortSignal, retainLeaseUntil) =>
      await destroyDeleteDeviceTarget(state, args, requester, retainLeaseUntil),
    verify: async (state, stop) => await verifyDeleteDeviceTarget(state, stop, deps),
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
      // A typed refusal (a broker binding or a session took the device between the entry check and
      // the shutdown reservation, a shutdown or capacity refusal) keeps its code and retry hints.
      const typed = typedTeardownRefusal(args, effectiveError, state?.target.device, phase);
      if (typed) {
        return typed;
      }
      return createTeardownFailureResponse(
        args,
        phase,
        effectiveError instanceof PooledAvdIdentityError
          ? "target_identity_unresolved"
          : "operation_failed",
        {
          message: String(
            effectiveError instanceof Error ? effectiveError.message : effectiveError,
          ),
          resolved: state?.target.device,
        },
      );
    },
  };
}

/** Maps a deleteDevice failure before or during the teardown to its typed precondition response. */
function deleteDeviceCatchResponse(
  args: TeardownDeviceArgs,
  error: unknown,
  callerSignal: AbortSignal | undefined,
): TeardownToolResponse {
  const message = String(error instanceof Error ? error.message : error);
  if (isProvisionDeviceCallerAbort(error, callerSignal)) {
    // Caller cancellation ends only this wait; the accepted teardown continues independently.
    logger.debug(
      `[DeviceTools] teardown caller stopped waiting for ${args.target.platform}:${args.target.stableId}: ${message}`,
    );
    return createTeardownFailureResponse(args, "precondition", "operation_cancelled", { message });
  }
  logger.warn(
    `[DeviceTools] teardown failed for ${args.target.platform}:${args.target.stableId}: ${message}`,
    error,
  );
  return (
    typedTeardownRefusal(args, error) ??
    createTeardownFailureResponse(args, "precondition", "operation_failed", { message })
  );
}

async function runDeleteDevice(
  args: TeardownDeviceArgs,
  deps: DeviceToolsDependencies,
  callerSignal: AbortSignal | undefined,
  {
    teardownService,
    lifecycleLease,
    requester,
    internal,
  }: DeleteDeviceOptions & { teardownService: DeviceTeardownService },
): Promise<TeardownToolResponse> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS;
  const deadlineMs = deps.timer.now() + timeoutMs;
  const stopIdentities: TeardownStopIdentities = new Map();
  // Refuse a broker binding's device before reserving the teardown lease, as killDevice does:
  // that reservation preempts the broker's in-flight acquisition even when the delete is then
  // refused (#11271). The workflow re-checks under the lease.
  try {
    // Likewise the session-holder refusal (#11274); it needs the resolved target, so it
    // resolves read-only first. The workflow re-checks both under the lease.
    const refusal = await preLeaseRefusal(
      { args, deps, deadlineMs, timeoutMs, requestAbortSignal: callerSignal, stopIdentities },
      requester,
      lifecycleLease,
    ).catch((error: unknown) => {
      lifecycleLease?.release();
      throw error;
    });
    if (refusal) {
      lifecycleLease?.release();
      return refusal;
    }
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
      createDeleteDeviceWorkflow(args, deps, deadlineMs, {
        timeoutMs,
        stopIdentities,
        requester,
        internal,
      }),
    );
  } catch (error) {
    return deleteDeviceCatchResponse(args, error, callerSignal);
  }
}

/** Canonicalize the simulator family before ownership checks and lifecycle admission. */
async function resolveKillDeviceArgs(
  args: KillDeviceArgs,
  deps: DeviceToolsDependencies,
  signal?: AbortSignal,
): Promise<KillDeviceArgs> {
  const manager = deps.deviceManagerFactory();
  const device = (await manager.resolveKillDeviceTarget?.(args.device, signal)) ?? args.device;
  return { ...args, device };
}

// Shared stop step. Public killDevice admission stays at its handler boundary below.
async function stopDevice(
  args: KillDeviceArgs,
  _progress?: ProgressCallback,
  abortSignal?: AbortSignal,
) {
  const deps = getDeviceToolsDependencies();
  const requestAbortSignal = abortSignal ?? getAbortSignal();
  const deadlineMs = deps.timer.now() + DEVICE_SHUTDOWN_TIMEOUT_MS;
  args = await resolveKillDeviceArgs(args, deps, requestAbortSignal);
  const stopIdentity = await assertKillDeviceCaller(args, deps, deadlineMs, requestAbortSignal);
  const { daemonState } = deps;
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
    ? await reserveStableDeviceLifecycle(stableTarget, args.device, deps.timer, {
        deadlineMs,
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
        stoppingSessionUuid: lifecycleRequester(args).sessionUuid,
        stoppingMcpSessionId: lifecycleRequester(args).mcpSessionId,
        stableIds: [args.device.name],
        stopIdentity,
        retainLifecycleUntil,
        pooledAvdIdentity: pooledAvdKillIdentity(pooledAvdCapture, args.force ?? false),
        // The entry check predates the lease wait; re-check under the assignment mutex.
        assertHolder: (confirmedIdentity = stopIdentity) =>
          assertLifecycleCallerHoldsDevice({
            checkRestartHold: true,
            toolName: "killDevice",
            device: args.device,
            requester: lifecycleRequester(args),
            force: args.force ?? false,
            stableIds: [args.device.name],
            stopIdentity: confirmedIdentity,
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
}

export function createLifecycleHandlers(options: { iosDeleteGate?: BootConcurrencyPool } = {}) {
  const iosDeleteGate = options.iosDeleteGate ?? new BootConcurrencyGate(IOS_DELETE_CONCURRENCY);

  const killDeviceHandler = async (
    args: KillDeviceArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    assertRequestNotTvos("killDevice", args);
    return await stopDevice(args, progress, signal);
  };

  async function executeDeleteDevice(
    args: TeardownDeviceArgs,
    deps: DeviceToolsDependencies,
    callerSignal: AbortSignal | undefined,
    {
      teardownService,
      lifecycleLease,
      requester,
      internal,
    }: DeleteDeviceOptions & { teardownService: DeviceTeardownService },
  ): Promise<TeardownToolResponse> {
    // Queue before the deadline starts, so waiting for a turn never spends the delete's own budget.
    let permit: Awaited<ReturnType<BootConcurrencyPool["acquire"]>> | undefined;
    if (args.target.platform === "ios") {
      try {
        permit = await iosDeleteGate.acquire(callerSignal, args.target.stableId);
      } catch (error) {
        lifecycleLease?.release();
        return deleteDeviceCatchResponse(args, error, callerSignal);
      }
    }
    try {
      return await runDeleteDevice(args, deps, callerSignal, {
        teardownService,
        lifecycleLease,
        requester,
        internal,
      });
    } finally {
      permit?.release();
    }
  }

  const deleteDeviceHandler = async (
    args: RegisteredTeardownArgs,
    _progress?: ProgressCallback,
    abortSignal?: AbortSignal,
  ) => {
    if (args.target.platform === "tvos" || isWatchTeardownRequest(args)) {
      const force = args.force ?? false;
      const remove = args.target.platform === "tvos" ? deleteAppleTvDevice : deleteWatchDevice;
      return await remove(
        args,
        {
          assertCaller: (device) => assertWatchDeleteCaller(device, args, force),
          // The shared killDevice step judges the same caller and releases the simulator session.
          stop: (device, signal) => stopDevice({ ...args, device, force }, undefined, signal),
        },
        abortSignal ?? getAbortSignal(),
      );
    }
    const deps = getDeviceToolsDependencies();
    return await executeDeleteDevice(args, deps, abortSignal ?? getAbortSignal(), {
      teardownService: getDeviceTeardownService(deps),
      requester: lifecycleRequester(args),
    });
  };

  return { killDeviceHandler, executeDeleteDevice, deleteDeviceHandler };
}
