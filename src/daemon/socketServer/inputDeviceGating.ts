import { runWithToolSelectionContext } from "../../features/toolSelection/toolSelectionContext";
import type { BootedDevice } from "../../models";
import { SessionNoLongerOwnsDeviceError } from "../../models/sessionNoLongerOwnsDevice";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { PlatformDeviceManagerFactory } from "../../utils/factories/PlatformDeviceManagerFactory";
import { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import { readFramePlatformHint } from "../daemonRequestEnvelope";
import { DaemonStateAccess } from "../daemonRequestHandlers";
import { getDeviceDataStreamServer } from "../deviceDataStreamSocketServer";
import {
  executionTracker,
  sessionExecutionMetadataOf,
  type ActiveExecution,
} from "../executionTracker";
import { type CanonicalFrameDiscovery } from "../frameDeviceIdentity";
import type { ForeignDaemonClaimGate } from "../inputDeviceOwnership";
import {
  admitInputOnHolderSession,
  assertControlNotOnForeignDaemonDevice,
  assertInputNotOnForeignBindingDevice,
  assertInputRequesterHoldsDevice,
  parseInputRequesterSessionUuid,
} from "../inputDeviceOwnership";
import { DISPATCH_HELD_INPUT_METHODS, type InputRouteMethod } from "../inputRoutes";
import { MCP_QUEUE_TIMEOUT_ERROR_CODE, McpTimeoutError } from "../wire/McpTimeoutError";
import {
  brokerConnectionControlRefusal,
  brokerConnectionHostMutationRefusal,
} from "../sessionBroker/connectionScope";
import {
  SessionReleasedDuringCallError,
  sessionReleaseThatCancelledCall,
} from "../sessionReleasedDuringCall";
import { DaemonRequest } from "../types";
import { indeterminateInputError } from "./forwardFailures";
import { InputTypeTextAppendError } from "./inputTypeTextAppendError";
import { type McpForwardChainWait } from "./keyedSerialQueue";

/**
 * One `input/*` frame's device work. It calls `dispatching` once every pre-dispatch check passed
 * (owner still there, current frame context, budget left, coordinates in bounds), immediately
 * at the successful send for tap/swipe, or before device work for the other input routes: only
 * then is the frame use of the holder's session (#11596, #11750).
 * `runTrackedDeviceInput` always supplies it; it is absent only when a test drives a handler
 * without that funnel.
 */
export type InputOperation<T> = (signal?: AbortSignal, dispatching?: () => void) => Promise<T>;

/** Owner context the socket path hands to an `input/*` handler (#10006). */
export interface InputRequestContext {
  /** Synchronously ends the admission cancellation race at this frame's first send. */
  onDispatch?: () => void;
  /** Aborts on socket close and on `daemon/cancelRequest` for this frame. */
  signal?: AbortSignal;
  /** When the frame was received; the whole budget, socket queue wait included, runs from here. */
  receivedAtMs?: number;
  /**
   * The device session the frame acts for (#10698), resolved only when the target device is held;
   * undefined for a sessionless frame.
   */
  requester?: () => string | undefined;
}

/** How an `input/*` frame's target is listed and whose frame it is. */
export interface InputTargetResolveOptions {
  /** Re-read the Android device list instead of a cached one; defaults off. */
  bypassAndroidDeviceListCache?: boolean;
  requester?: InputRequestContext["requester"];
}

/** Owner fence and device-key wait bound for one tracked `input/*` execution. */
export interface InputDeviceGate {
  onDispatch?: () => void;
  ownerSignal?: AbortSignal;
  chainWait?: McpForwardChainWait;
  /** Who sent the frame; only the device's holder may drive a held device (#10698). */
  requester?: () => string | undefined;
}

/** What every input device write settles with. */
export interface InputRouteResult {
  success: boolean;
  error?: string;
}

export interface InputRouteArgs {
  platform: "android" | "ios";
  deviceId?: string;
  frameContext?: string;
}

/** What `runInputRoute` hands a route's dispatch once every pre-dispatch check has passed. */
export interface InputRouteStep {
  targetDevice: BootedDevice;
  /** The device the write targets: the target, or its re-resolved transport. */
  executionDevice: BootedDevice;
  signal: AbortSignal | undefined;
  /** Stamps the session's idle window; call it only when the device write starts. */
  dispatching: (() => void) | undefined;
  remainingTimeoutMs: number;
  queueEnterMs: number;
  totalTimeoutMs: number;
}

export interface InputRouteRun<A extends InputRouteArgs, R extends InputRouteResult> {
  action: InputTargetAction;
  origin: string;
  args: A;
  bypassAndroidDeviceListCache?: boolean;
  /** Re-reads the device inside the keyed callback (typeText append). */
  reresolve?: (device: BootedDevice) => Promise<BootedDevice>;
  /** Whether the args' frameContext must still be the device's current frame. */
  checksFrame: boolean;
  /** Wraps the whole tracked run (gesture stroke lifting on a session refusal). */
  around?: (device: BootedDevice, run: () => Promise<R>) => Promise<R>;
  dispatch: (step: InputRouteStep) => Promise<R>;
}

export type InputTargetAction = InputRouteMethod;

/** Server state and method seams are resolved lazily so instance overrides remain effective. */
export interface InputDeviceGatingPorts {
  daemonState: () => {
    isInitialized(): boolean;
    getBrokerConnectionScopes?: DaemonStateAccess["getBrokerConnectionScopes"];
    getSessionManager(): Pick<
      ReturnType<DaemonStateAccess["getSessionManager"]>,
      "getSession" | "getSessionForDevice" | "getDeviceLabels"
    >;
    getDevicePool(): Pick<
      ReturnType<DaemonStateAccess["getDevicePool"]>,
      | "resolveAutolockSessionForMcpSession"
      | "assertSessionReadyForAutomation"
      | "reconcileDiscoveryObservation"
      | "assertDeviceActionable"
      | "assertNotAssignedToBinding"
    > &
      ForeignDaemonClaimGate;
  };
  selectInputTargetDevice: InputDeviceGating["selectInputTargetDevice"];
  assertFrameTargetProven(
    device: BootedDevice,
    action: string,
    requester?: () => string | undefined,
  ): Promise<void>;
  assertBrokerConnectionInputTarget: InputDeviceGating["assertBrokerConnectionInputTarget"];
  captureInputTargetOwner: InputDeviceGating["captureInputTargetOwner"];
  assertBrokerConnectionControl: InputDeviceGating["assertBrokerConnectionControl"];
  inputTargetOwners: () => WeakMap<BootedDevice, string>;
  discoverInputTargetDevices: InputDeviceGating["discoverInputTargetDevices"];
  runTrackedDeviceInput: InputDeviceGating["runTrackedDeviceInput"];
  runKeyedMcpForward<T>(
    executionKey: string,
    fn: () => Promise<T>,
    idleCloseKey?: string,
    chainWait?: McpForwardChainWait,
  ): Promise<T>;
  runHeldInputOperation: InputDeviceGating["runHeldInputOperation"];
  timer: () => Pick<Timer, "now">;
  holdDispatchedInputRequest<T>(
    signal: AbortSignal | undefined,
    timeoutMs: number,
    send: (fenced: AbortSignal | undefined, onDispatch: () => void) => Promise<T>,
    options?: { onDispatch?: () => void; label?: string },
  ): Promise<T>;
  assertDeviceActionable: InputDeviceGating["assertDeviceActionable"];
  assertInputBindingGate: InputDeviceGating["assertInputBindingGate"];
  admitInputAsControlCall: InputDeviceGating["admitInputAsControlCall"];
  runCancellableInputHandler<T>(
    handler: (onDispatch: () => void) => Promise<T>,
    cancelSignal: AbortSignal | undefined,
  ): Promise<T>;
  answeringSessionRelease: InputDeviceGating["answeringSessionRelease"];
  runFencedInputOperation: InputDeviceGating["runFencedInputOperation"];
  canonicalFrameDiscovery(
    platform: "android" | "ios",
    rawDevices: readonly BootedDevice[],
    deviceId: string | undefined,
  ): Promise<CanonicalFrameDiscovery>;
  reconcileDiscoveryObservation: InputDeviceGating["reconcileDiscoveryObservation"];
}

/** Input operations; mutable state remains owned by UnixSocketServer. */
export class InputDeviceGating {
  constructor(private readonly ports: InputDeviceGatingPorts) {}

  /**
   * Input that carries a device-authored context is safe only if the newest observation from that
   * device still reports that exact context. Missing context fails closed: a caller can re-observe
   * and retry, whereas executing against an unproven screen could actuate the wrong UI.
   */
  requireCurrentFrameContext(
    deviceId: string,
    frameContext: string | undefined,
    action: string,
  ): void {
    if (frameContext === undefined) {
      return;
    }
    const current = getDeviceDataStreamServer()?.getCurrentFrameContext(deviceId);
    if (current !== frameContext) {
      throw new Error(
        `${action} frameContext is stale or unavailable; observe a fresh frame before retrying`,
      );
    }
  }

  /**
   * The device session an `input/*` frame acts for (#10698): its explicit `sessionUuid`, else the
   * device session this socket's MCP session is autolocked to for the frame's platform (a proxy
   * connection that already drives that session's device). A malformed `sessionUuid` fails here,
   * before any device work; the autolock fallback is read only when a held device needs it.
   */
  inputRequester(
    request: DaemonRequest,
    socketSessionId: string | undefined,
  ): () => string | undefined {
    const explicit = parseInputRequesterSessionUuid(request.method, request.params);
    return () => {
      if (explicit || !socketSessionId || !this.ports.daemonState().isInitialized()) {
        return explicit;
      }
      const platform = readFramePlatformHint(request.params);
      if (!platform) {
        return undefined;
      }
      return this.ports
        .daemonState()
        .getDevicePool()
        .resolveAutolockSessionForMcpSession?.(socketSessionId, platform);
    };
  }

  async resolveInputTargetDevice(
    platform: "android" | "ios",
    deviceId: string | undefined,
    socketSessionId: string | undefined,
    {
      action,
      bypassAndroidDeviceListCache = false,
      requester,
    }: InputTargetResolveOptions & { action: InputTargetAction },
  ): Promise<BootedDevice> {
    const targetDevice = await this.ports.selectInputTargetDevice(
      platform,
      deviceId,
      socketSessionId,
      { action, bypassAndroidDeviceListCache },
    );
    await this.ports.assertFrameTargetProven(targetDevice, action, requester);
    this.ports.assertBrokerConnectionInputTarget(socketSessionId, action, targetDevice.deviceId);
    this.ports.captureInputTargetOwner(targetDevice);
    return targetDevice;
  }

  /**
   * An `input/*` frame is control: a socket bound to broker bindings drives only its own binding devices
   * (#11178). Streams and other reads stay open. Generic sockets are unaffected here; their frames
   * on a binding device are refused by the broker binding gate in {@link runTrackedDeviceInput}.
   */
  assertBrokerConnectionInputTarget(
    socketSessionId: string | undefined,
    action: InputTargetAction,
    deviceId: string,
  ): void {
    this.ports.assertBrokerConnectionControl(socketSessionId, action, { deviceId });
  }

  /**
   * The one confinement every control frame from a managed connection passes (#11178, #11596): the
   * device it would act on is one of the connection's binding devices, and the session it names is
   * one of its binding sessions. A generic (unbound) socket is never refused here.
   */
  assertBrokerConnectionControl(
    socketSessionId: string | undefined,
    action: string,
    target: { deviceId?: string; requesterSessionUuid?: string },
  ): void {
    if (!this.ports.daemonState().isInitialized()) {
      return;
    }
    const sessionManager = this.ports.daemonState().getSessionManager();
    const refusal = brokerConnectionControlRefusal({
      binding: this.ports.daemonState().getBrokerConnectionScopes?.().get(socketSessionId),
      action,
      deviceId: target.deviceId,
      requesterSessionUuid: target.requesterSessionUuid,
      grantedDeviceOf: (sessionUuid) => sessionManager.getSession(sessionUuid)?.assignedDevice,
    });
    if (refusal) {
      throw refusal;
    }
  }

  assertBrokerConnectionHostMutation(socketSessionId: string | undefined, action: string): void {
    if (!this.ports.daemonState().isInitialized()) {
      return;
    }
    const refusal = brokerConnectionHostMutationRefusal({
      binding: this.ports.daemonState().getBrokerConnectionScopes?.().get(socketSessionId),
      action,
    });
    if (refusal) {
      throw refusal;
    }
  }

  captureInputTargetOwner(targetDevice: BootedDevice): void {
    if (!this.ports.daemonState().isInitialized()) {
      return;
    }
    const owner = this.ports
      .daemonState()
      .getSessionManager()
      .getSessionForDevice?.(targetDevice.deviceId);
    if (owner) {
      this.ports.inputTargetOwners().set(targetDevice, owner);
    }
  }

  async selectInputTargetDevice(
    platform: "android" | "ios",
    deviceId: string | undefined,
    socketSessionId: string | undefined,
    {
      action,
      bypassAndroidDeviceListCache = false,
    }: { action: InputTargetAction; bypassAndroidDeviceListCache?: boolean },
  ): Promise<BootedDevice> {
    const { devices: bootedDevices, deviceId: canonicalDeviceId } =
      await this.ports.discoverInputTargetDevices(
        platform,
        action,
        bypassAndroidDeviceListCache,
        deviceId,
      );
    if (canonicalDeviceId) {
      const targetDevice = bootedDevices.find((device) => device.deviceId === canonicalDeviceId);
      if (!targetDevice) {
        throw new Error(`Device not found: ${deviceId}`);
      }
      return targetDevice;
    }

    const autolockSessionId = this.ports.daemonState().isInitialized()
      ? this.ports
          .daemonState()
          .getDevicePool()
          .resolveAutolockSessionForMcpSession?.(socketSessionId, platform)
      : undefined;
    const autolockDeviceId = autolockSessionId
      ? this.ports.daemonState().getSessionManager().getSession(autolockSessionId)?.assignedDevice
      : undefined;
    if (autolockDeviceId) {
      const targetDevice = bootedDevices.find((device) => device.deviceId === autolockDeviceId);
      if (!targetDevice) {
        throw new Error(`Device not found: ${autolockDeviceId}`);
      }
      return targetDevice;
    }

    if (bootedDevices.length === 1) {
      return bootedDevices[0];
    }
    if (bootedDevices.length === 0) {
      throw new Error(`No booted ${platform} devices found for ${action}`);
    }
    throw new Error(`${action} requires deviceId when multiple ${platform} devices are booted`);
  }

  async runTrackedKeyedDeviceInput<T>(
    toolName: string,
    targetDevice: BootedDevice,
    operation: InputOperation<T>,
    gate?: InputDeviceGate,
  ): Promise<T> {
    const executionKey = `device:${targetDevice.deviceId}`;
    return await this.ports.runTrackedDeviceInput(
      toolName,
      targetDevice,
      async (signal, dispatching) =>
        this.ports.runKeyedMcpForward(
          executionKey,
          () => {
            // Parked on the device key, the input may have been cancelled (a session acquired the
            // device, #10829): it is not sent.
            signal?.throwIfAborted();
            return this.ports.runHeldInputOperation(toolName, signal, operation, () => {
              gate?.onDispatch?.();
              dispatching?.();
            });
          },
          executionKey,
          gate?.chainWait,
        ),
      { ownerSignal: gate?.ownerSignal, requester: gate?.requester },
    );
  }

  /**
   * What an `input/*` handler needs on top of the tracked execution: the owner's abort signal
   * (socket close / client cancel) and a bound on how long it may park on the device key, both
   * measured against the budget that started at frame receipt (#10006).
   */
  inputDeviceGate(
    toolName: string,
    origin: string,
    totalTimeoutMs: number,
    { budgetStartMs, input }: { budgetStartMs: number; input?: InputRequestContext },
  ): InputDeviceGate {
    const remainingMs = () => totalTimeoutMs - (this.ports.timer().now() - budgetStartMs);
    return {
      onDispatch: input?.onDispatch,
      ownerSignal: input?.signal,
      requester: input?.requester,
      chainWait: {
        remainingMs,
        timeoutError: (executionKey) =>
          new McpTimeoutError({
            toolName,
            timeoutMs: totalTimeoutMs,
            origin,
            detail: `spent ${totalTimeoutMs - remainingMs()}ms waiting in queue for ${executionKey}`,
            code: MCP_QUEUE_TIMEOUT_ERROR_CODE,
          }),
      },
    };
  }

  /** Preserve ordinary errors; a post-send cancellation is always indeterminate. */
  async runHeldInputOperation<T>(
    method: string,
    signal: AbortSignal | undefined,
    operation: InputOperation<T>,
    onDispatch: () => void,
  ): Promise<T> {
    if (!DISPATCH_HELD_INPUT_METHODS.has(method) || method === "input/typeText") {
      return operation(signal, onDispatch);
    }
    let dispatched = false;
    const dispatch = () => {
      if (!dispatched) {
        onDispatch();
        dispatched = true;
      }
    };
    try {
      const result = await operation(signal, dispatch);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (dispatched && signal?.aborted) {
        throw indeterminateInputError(method, error);
      }
      // Keep the existing plain cancellation for an unlabelled caller abort.
      if (signal?.reason instanceof DOMException && signal.reason.name === "AbortError") {
        throwIfAborted(signal);
      }
      signal?.throwIfAborted();
      throw error;
    }
  }

  dispatchFencedInput<T>(
    gesture: "Tap" | "Swipe",
    signal: AbortSignal | undefined,
    timeoutMs: number,
    {
      send,
      onDispatch,
    }: {
      send: (fenced: AbortSignal | undefined, onDispatch: () => void) => Promise<T>;
      onDispatch?: () => void;
    },
  ): Promise<T> {
    return this.ports.runHeldInputOperation(
      `input/${gesture.toLowerCase()}`,
      signal,
      (_signal, dispatch) =>
        this.ports.holdDispatchedInputRequest(signal, timeoutMs, send, {
          onDispatch: dispatch,
          label: `${gesture} request`,
        }),
      () => onDispatch?.(),
    );
  }

  /**
   * FUNNEL 1 for this socket server: fold a discovery observation into pooled
   * identity before anything here joins it to pool state. See
   * `DevicePool.reconcileDiscoveryObservation`. A no-op in direct mode, where
   * there is no pool.
   */
  async reconcileDiscoveryObservation(
    devices: readonly BootedDevice[],
    source: string,
  ): Promise<void> {
    if (!this.ports.daemonState().isInitialized()) {
      return;
    }
    await this.ports.daemonState().getDevicePool().reconcileDiscoveryObservation?.(devices, source);
  }

  /**
   * FUNNEL 2 for this socket server: refuse a serial whose pooled identity is
   * quarantined. See `DevicePool.assertDeviceActionable`. A no-op in direct mode,
   * where nothing holds cross-call identity state to quarantine.
   */
  assertDeviceActionable(deviceId: string, purpose: string): void {
    if (!this.ports.daemonState().isInitialized()) {
      return;
    }
    this.ports.daemonState().getDevicePool().assertDeviceActionable?.(deviceId, purpose);
  }

  /** A broker binding's device, idle or held, takes input only from that binding's execution (#11178). */
  async assertInputBindingGate(
    toolName: string,
    targetDevice: BootedDevice,
    requester: (() => string | undefined) | undefined,
  ): Promise<void> {
    if (!this.ports.daemonState().isInitialized()) {
      return;
    }
    await assertInputNotOnForeignBindingDevice({
      action: toolName,
      deviceId: targetDevice.deviceId,
      platform: targetDevice.platform,
      requesterSessionUuid: requester?.(),
      sessionManager: this.ports.daemonState().getSessionManager(),
      gate: this.ports.daemonState().getDevicePool(),
    });
    // A device no local session holds takes no input while another daemon claims it (#11349).
    await assertControlNotOnForeignDaemonDevice({
      deviceId: targetDevice.deviceId,
      platform: targetDevice.platform,
      gate: this.ports.daemonState().getDevicePool(),
    });
  }

  async runTrackedDeviceInput<T>(
    toolName: string,
    targetDevice: BootedDevice,
    operation: InputOperation<T>,
    { ownerSignal, requester }: { ownerSignal?: AbortSignal; requester?: () => string | undefined },
  ): Promise<T> {
    // FUNNEL 2, ahead of the session lookup: a device-addressed input on a
    // quarantined serial must be refused WITH OR WITHOUT a session. The
    // session-keyed gate below cannot see an idle emulator, so an explicit
    // `deviceId` tap on one used to execute against whatever now answers on that
    // serial ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
    this.ports.assertDeviceActionable(targetDevice.deviceId, "to run");
    const sessionManager = this.ports.daemonState().isInitialized()
      ? this.ports.daemonState().getSessionManager()
      : undefined;
    const sessionUuid = sessionManager?.getSessionForDevice?.(targetDevice.deviceId) ?? undefined;
    // A held device takes input only from its holder (#10698); checked here, the one funnel every
    // `input/*` handler runs through, before anything reaches the device.
    await this.ports.assertInputBindingGate(toolName, targetDevice, requester);
    assertInputRequesterHoldsDevice({
      action: toolName,
      deviceId: targetDevice.deviceId,
      ownerSessionUuid: sessionUuid,
      requesterSessionUuid: sessionUuid ? requester?.() : undefined,
      sessionManager,
    });
    if (sessionUuid) {
      this.ports.daemonState().getDevicePool().assertSessionReadyForAutomation?.(sessionUuid);
    }
    const resolvedOwner = this.ports.inputTargetOwners().get(targetDevice);
    if (resolvedOwner !== undefined && resolvedOwner !== sessionUuid) {
      // The target was resolved for `resolvedOwner`, which has since left the device (rebind or
      // release). Running now would drive it as an unowned call or as the next owner's (#9958).
      throw new SessionNoLongerOwnsDeviceError(
        resolvedOwner,
        targetDevice.deviceId,
        `Session ${resolvedOwner} no longer owns device '${targetDevice.deviceId}' (it was rebound ` +
          `or released after this input resolved its target); the input was not sent.`,
      );
    }
    const execution = executionTracker.startExecution(toolName, undefined, sessionUuid);
    const signal = execution.abortController.signal;
    try {
      executionTracker.bindDeviceExecution(execution.id, targetDevice.deviceId);
      signal.throwIfAborted();
      await this.ports.admitInputAsControlCall(
        execution,
        targetDevice.deviceId,
        sessionUuid,
        ownerSignal,
      );
      // The holder, readiness and admission checks passed, so the execution stays tracked as
      // control in flight on the session from here on. It is USE of the session (#10824) only once
      // the handler's own pre-dispatch checks passed too: a frame refused for a stale frame
      // context, spent budget or out-of-bounds coordinates sends nothing and must not restart the
      // idle window (#11596).
      const dispatching = () => executionTracker.markSessionAdmitted(execution.id);
      if (!sessionUuid) {
        // Admitted on a device no session holds: a session acquiring it while this input is parked
        // or in flight cancels it (#10829).
        executionTracker.markSessionlessDeviceUse(execution.id, targetDevice.deviceId);
      }
      const runOperation = (fenced?: AbortSignal) =>
        DISPATCH_HELD_INPUT_METHODS.has(toolName)
          ? this.ports.runCancellableInputHandler(
              (onDispatch) =>
                operation(fenced, () => {
                  onDispatch();
                  dispatching();
                }),
              fenced,
            )
          : operation(fenced, dispatching);
      return await this.ports.answeringSessionRelease(execution, () =>
        runWithToolSelectionContext(
          {
            execution: {
              ...sessionExecutionMetadataOf(execution),
              deviceBinding: {
                bindDeviceExecution: (deviceId) =>
                  executionTracker.bindDeviceExecution(execution.id, deviceId),
              },
            },
          },
          () => this.ports.runFencedInputOperation(signal, ownerSignal, runOperation),
        ),
      );
    } finally {
      executionTracker.endExecution(execution.id);
    }
  }

  /**
   * Input on a held device is a control call on the holder's session: refused while the session is
   * suspect, lapsed or past its idle deadline, exactly as an MCP control call is (#11417). Input
   * on a device no session holds has no session to admit.
   *
   * Admission runs under the execution's signal and the caller's own (`ownerSignal`: the frame's
   * socket close or client cancel, or the `ide/*` route's signal), passed explicitly rather than
   * read ambiently (#15671).
   */
  async admitInputAsControlCall(
    execution: ActiveExecution,
    deviceId: string,
    holderSessionUuid: string | undefined,
    ownerSignal: AbortSignal | undefined,
  ): Promise<void> {
    if (!holderSessionUuid) {
      return;
    }
    const trackerSignal = execution.abortController.signal;
    await admitInputOnHolderSession({
      deviceId,
      holderSessionUuid,
      sessionManager: this.ports.daemonState().getSessionManager(),
      execution: sessionExecutionMetadataOf(execution),
      signal: ownerSignal ? AbortSignal.any([trackerSignal, ownerSignal]) : trackerSignal,
    });
    // A release that landed while admission was awaited answers its own typed refusal.
    await this.ports.answeringSessionRelease(execution, async () =>
      execution.abortController.signal.throwIfAborted(),
    );
  }

  /**
   * Run a tracked input and, when the daemon released its session mid-call and that release
   * cancelled it, answer the typed terminal refusal the MCP path gives, whatever the interrupted
   * operation threw (#11381). The thrown release carries its wire fields to the failure frame.
   */
  async answeringSessionRelease<T>(
    execution: Pick<ActiveExecution, "cancelReason"> & Partial<Pick<ActiveExecution, "toolName">>,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const released = sessionReleaseThatCancelledCall(execution.cancelReason);
      if (
        released &&
        error instanceof Error &&
        "requestDispatched" in error &&
        error.requestDispatched === true
      ) {
        // A release error can cancel several calls. Keep its class and wire fields without
        // mutating the shared reason (a concurrent call must not inherit another call's send note or append count).
        const dispatchedRelease = new SessionReleasedDuringCallError(
          released.sessionUuid,
          released.releaseReason,
        );
        const request =
          execution.toolName === "input/typeText" || error instanceof InputTypeTextAppendError
            ? "the text request"
            : "the request";
        dispatchedRelease.message = `${released.message} Cancellation arrived after ${request} had been dispatched; its outcome is indeterminate.`;
        if (error instanceof InputTypeTextAppendError) {
          dispatchedRelease.charsSent = error.charsSent;
        }
        throw dispatchedRelease;
      }
      throw released ?? error;
    }
  }

  /**
   * Run an input operation under the tracker's signal AND the owner's: an `input/*` frame whose
   * socket closed or whose client cancelled it aborts exactly like a torn-down session (#10006).
   */
  runFencedInputOperation<T>(
    trackerSignal: AbortSignal,
    ownerSignal: AbortSignal | undefined,
    operation: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signal = ownerSignal ? AbortSignal.any([trackerSignal, ownerSignal]) : trackerSignal;
    signal.throwIfAborted();
    return runWithAbortSignal(signal, () => operation(signal));
  }

  async discoverInputTargetDevices(
    platform: "android" | "ios",
    action: InputTargetAction,
    bypassAndroidDeviceListCache: boolean,
    deviceId: string | undefined,
  ): Promise<CanonicalFrameDiscovery> {
    const discovery = await PlatformDeviceManagerFactory.getInstance().getBootedDevicesDetailed(
      platform,
      {
        bypassAndroidDeviceListCache,
      },
    );
    // The frame's rows and device id as pooled canonical ids, before anything reads pool state.
    const canonical = await this.ports.canonicalFrameDiscovery(
      platform,
      discovery.devices,
      deviceId,
    );
    // FUNNEL 1: the target this resolves is handed straight to the device-addressed
    // admission gate, which reads pool state — so the pool must have seen this
    // observation first (#6863 review).
    await this.ports.reconcileDiscoveryObservation(canonical.devices, `socket:${action}`);
    if (!discovery.succeededPlatforms.has(platform)) {
      throw new Error(`Unable to discover booted ${platform} devices for ${action}`);
    }
    return canonical;
  }
}
