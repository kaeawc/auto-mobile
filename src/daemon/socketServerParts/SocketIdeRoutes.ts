import { IdeDeviceRoutes } from "../socketServer/ideDeviceRoutes";

import {
  dispatchInputRoute,
  isOwnerFencedMethod,
  type InputRouteHandlers,
} from "../socketServer/controlRoutes";
import { IDE_DEVICE_MUTATION_METHODS } from "../ideRoutes";
import { ideFeatureRoutes } from "../socketServer/ideRouteModule";
import type { IdeMutationCall } from "../socketServer/ideMutationCall";
import { daemonLifecycleRoutes } from "../socketServer/lifecycleRouteModule";
import { inputRouteFor, type InputRouteEntry } from "../inputRoutes";

import { Socket } from "node:net";

import { DaemonRequest } from "../types";

import { ListChangedBroadcaster } from "../listChangedBroadcast";

import { IDE_SET_SESSION_TOOL_ENABLED_METHOD } from "../../features/toolSelection/toolSelectionControl";

import { getSessionToolSelectionService } from "../../features/toolSelection/SessionToolSelectionService";
import { assertToolEnabledForAnySession } from "../../features/toolSelection/toolSelectionPolicy";
import { resolveToolSelectionBaseSessionUuid } from "../../features/toolSelection/selectionSessionResolver";

import { daemonToolRegistry } from "../toolRegistryPort";
import { type CanonicalFrameDiscovery } from "../frameDeviceIdentity";

import { type AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";

import type { PreferenceStoreResolution } from "../../features/storage/storageTypes";
import type { BootedDevice } from "../../models";
import { type ActiveExecution } from "../executionTracker";

import {
  InputDeviceGating,
  type InputDeviceGate,
  type InputOperation,
  type InputRequestContext,
  type InputTargetAction,
  type InputTargetResolveOptions,
} from "../socketServer/inputDeviceGating";

import { IdeServerRouteHandler } from "./socketServerContracts";

import type { SocketServerRuntime } from "./SocketServerRuntime";
import type { SocketServerOperations } from "./socketServerOperations";
type State = Pick<
  SocketServerRuntime,
  | "daemonIdentity"
  | "identityStartedAt"
  | "identityProcessStartedAt"
  | "identityDbPath"
  | "identityPidFilePath"
  | "socketPath"
  | "identitySockets"
  | "startupOptions"
  | "processGenerationToken"
  | "acceptanceDiscoveryCapability"
  | "daemonState"
  | "adbClientFactory"
  | "sessionToolSelectionService"
  | "timer"
  | "restartAdmission"
  | "inputTargetOwners"
>;
type Callbacks = Pick<
  SocketServerOperations,
  | "handleLocalSocketRequest"
  | "mcpRequestSignal"
  | "inputRequester"
  | "dispatchInputRoute"
  | "dispatchIdeSocketRequest"
  | "handleInputTap"
  | "handleInputSwipe"
  | "handleInputTypeText"
  | "handleInputPressButton"
  | "handleInputKey"
  | "handleInputGesture"
  | "handleIdeSocketRequest"
  | "runTrackedIdeMutation"
  | "assertSocketToolEnabled"
  | "reconcileDiscoveryObservation"
  | "assertDeviceActionable"
  | "assertBrokerConnectionControl"
  | "admitInputAsControlCall"
  | "listBootedDevicesForIdeAction"
  | "resolveIdeActionDevices"
  | "runIdeKeyValueMutation"
  | "requireFeatureFlagService"
  | "assertBrokerConnectionHostMutation"
  | "republishDaemonIdentity"
  | "canonicalFrameDeviceId"
  | "selectInputTargetDevice"
  | "assertFrameTargetProven"
  | "assertBrokerConnectionInputTarget"
  | "captureInputTargetOwner"
  | "discoverInputTargetDevices"
  | "runTrackedDeviceInput"
  | "runKeyedMcpForward"
  | "runHeldInputOperation"
  | "holdDispatchedInputRequest"
  | "assertInputBindingGate"
  | "runCancellableInputHandler"
  | "answeringSessionRelease"
  | "runFencedInputOperation"
  | "canonicalFrameDiscovery"
>;
/** Socket Ide Routes over shared connection state and explicit callbacks. */
export class SocketIdeRoutes {
  constructor(
    private readonly state: State,
    private readonly resolveCallbacks: () => Callbacks,
  ) {}
  private get callbacks(): Callbacks {
    return this.resolveCallbacks();
  }
  /**
   * Input and device-mutating IDE frames share the owner fence of forwarded MCP calls: socket
   * close and `daemon/cancelRequest` abort them (#10006, #11667). Input also has a budget from receipt.
   * Other local requests run unfenced, as before.
   */
  async runLocalSocketRequest(
    request: DaemonRequest,
    sessionId: string,
    ownerSocket: Socket,
    {
      cancelSignal,
      receivedAtMs,
      onOwnerSignal,
      onInputDispatch,
    }: {
      cancelSignal: AbortSignal;
      receivedAtMs: number;
      onOwnerSignal: (signal: AbortSignal) => void;
      onInputDispatch?: () => void;
    },
  ): Promise<unknown> {
    if (!isOwnerFencedMethod(request.method, IDE_DEVICE_MUTATION_METHODS)) {
      return await this.callbacks.handleLocalSocketRequest(request, { socketSessionId: sessionId });
    }
    const owner = this.callbacks.mcpRequestSignal(sessionId, ownerSocket, cancelSignal);
    onOwnerSignal(owner.signal);
    try {
      return await this.callbacks.handleLocalSocketRequest(request, {
        socketSessionId: sessionId,
        signal: owner.signal,
        receivedAtMs,
        onInputDispatch,
      });
    } finally {
      owner.dispose();
    }
  }
  async handleLocalSocketRequest(
    request: DaemonRequest,
    {
      socketSessionId,
      signal,
      receivedAtMs,
      onInputDispatch,
    }: {
      socketSessionId?: string;
      signal?: AbortSignal;
      receivedAtMs?: number;
      onInputDispatch?: () => void;
    } = {},
  ): Promise<any | undefined> {
    if (request.method.startsWith("input/")) {
      // A frame whose socket closed or whose client cancelled it while it sat in the socket
      // queue must not even resolve a device (#10006).
      signal?.throwIfAborted();
    }
    const input: InputRequestContext = {
      onDispatch: onInputDispatch,
      signal,
      receivedAtMs,
      requester: request.method.startsWith("input/")
        ? this.callbacks.inputRequester(request, socketSessionId)
        : undefined,
    };
    const route = inputRouteFor(request.method);
    if (route) {
      return await this.callbacks.dispatchInputRoute(route, request, socketSessionId, input);
    }
    return await this.callbacks.dispatchIdeSocketRequest(request, socketSessionId, signal);
  }
  async dispatchInputRoute(
    route: InputRouteEntry,
    request: DaemonRequest,
    socketSessionId: string | undefined,
    input: InputRequestContext,
  ): Promise<any | undefined> {
    return await dispatchInputRoute(this.inputRouteHandlers, route, request, {
      socketSessionId,
      input,
    });
  }
  /** The handler each `input/*` route table entry names (#11815). */
  private readonly inputRouteHandlers: InputRouteHandlers<InputRequestContext> = {
    tap: (request, sid, input) => this.callbacks.handleInputTap(request, sid, input),
    swipe: (request, sid, input) => this.callbacks.handleInputSwipe(request, sid, input),
    typeText: (request, sid, input) => this.callbacks.handleInputTypeText(request, sid, input),
    pressButton: (request, sid, input) =>
      this.callbacks.handleInputPressButton(request, sid, input),
    key: (request, sid, input) => this.callbacks.handleInputKey(request, sid, input),
    gesture: (request, kind, sid, input) =>
      this.callbacks.handleInputGesture(request, kind, sid, input),
  };
  /** A route that mutates a device runs as one tracked control call (#11486); the rest run bare. */
  async dispatchIdeSocketRequest(
    request: DaemonRequest,
    socketSessionId?: string,
    signal?: AbortSignal,
  ): Promise<any | undefined> {
    if (!IDE_DEVICE_MUTATION_METHODS.has(request.method)) {
      return await this.callbacks.handleIdeSocketRequest(request, socketSessionId);
    }
    signal?.throwIfAborted();
    return await this.callbacks.runTrackedIdeMutation(
      socketSessionId,
      (call) => this.callbacks.handleIdeSocketRequest(request, socketSessionId, call),
      signal,
    );
  }
  private readonly ideDeviceRoutes = new IdeDeviceRoutes({
    daemonIdentity: () => this.state.daemonIdentity,
    identityStartedAt: () => this.state.identityStartedAt,
    identityProcessStartedAt: () => this.state.identityProcessStartedAt,
    identityDbPath: () => this.state.identityDbPath,
    identityPidFilePath: () => this.state.identityPidFilePath,
    socketPath: () => this.state.socketPath,
    identitySockets: () => this.state.identitySockets,
    startupOptions: () => this.state.startupOptions,
    processGenerationToken: () => this.state.processGenerationToken,
    acceptanceDiscoveryCapability: () => this.state.acceptanceDiscoveryCapability,
    daemonState: () => this.state.daemonState,
    adbClientFactory: () => this.state.adbClientFactory,
    assertSocketToolEnabled: (deviceId, toolName) =>
      this.callbacks.assertSocketToolEnabled(deviceId, toolName),
    reconcileDiscoveryObservation: (devices, source) =>
      this.callbacks.reconcileDiscoveryObservation(devices, source),
    assertDeviceActionable: (deviceId, purpose) =>
      this.callbacks.assertDeviceActionable(deviceId, purpose),
    assertBrokerConnectionControl: (socketSessionId, action, target) =>
      this.callbacks.assertBrokerConnectionControl(socketSessionId, action, target),
    admitInputAsControlCall: (...args) => this.callbacks.admitInputAsControlCall(...args),
    listBootedDevicesForIdeAction: (platform, serial, signal) =>
      this.callbacks.listBootedDevicesForIdeAction(platform, serial, signal),
    resolveIdeActionDevices: (platform, serial, signal) =>
      this.callbacks.resolveIdeActionDevices(platform, serial, signal),
    runIdeKeyValueMutation: (platform, device, appId, mutation) =>
      this.callbacks.runIdeKeyValueMutation(platform, device, appId, mutation),
  });
  /** The `ide/*` and daemon-lifecycle routes this socket serves, by method name (#11813). */
  private readonly ideRouteHandlers: ReadonlyMap<string, IdeServerRouteHandler> = new Map<
    string,
    IdeServerRouteHandler
  >([
    ...ideFeatureRoutes({
      requireFeatureFlagService: () => this.callbacks.requireFeatureFlagService(),
      sessionToolSelection: () =>
        this.state.sessionToolSelectionService ?? getSessionToolSelectionService(),
      assertBrokerHostMutation: (socketSessionId, action) =>
        this.callbacks.assertBrokerConnectionHostMutation(socketSessionId, action),
      assertBrokerControl: (socketSessionId, action, target) =>
        this.callbacks.assertBrokerConnectionControl(socketSessionId, action, target),
      emitToolsListChanged: () => ListChangedBroadcaster.emit("tools"),
      now: () => this.state.timer.now(),
    }),
    ...daemonLifecycleRoutes({
      republishIdentity: (params) => this.callbacks.republishDaemonIdentity(params),
      // Resolved per call: the admission object is built at the end of construction.
      restart: {
        prepareDaemonRestart: (params) => this.state.restartAdmission.prepareDaemonRestart(params),
        prepareDaemonMaintenance: (params) =>
          this.state.restartAdmission.prepareDaemonMaintenance(params),
        completeDaemonMaintenance: (params) =>
          this.state.restartAdmission.completeDaemonMaintenance(params),
        restartAdmittedDaemon: (params) =>
          this.state.restartAdmission.restartAdmittedDaemon(params),
        restartAcceptanceSession: (params, owner) =>
          this.state.restartAdmission.restartAcceptanceSession(params, owner),
        commitAcceptanceRestart: (params, owner) =>
          this.state.restartAdmission.commitAcceptanceRestart(params, owner),
        releaseAcceptanceRestart: (params, owner) =>
          this.state.restartAdmission.releaseAcceptanceRestart(params, owner),
      },
    }),
    ...this.ideDeviceRoutes.routes,
  ]);
  /**
   * The `ide/*` and acceptance routes. `ideMutation` is set for the routes that mutate a device
   * ({@link IDE_DEVICE_MUTATION_METHODS}): their ownership gate tracks the call under it.
   */
  async handleIdeSocketRequest(
    request: DaemonRequest,
    socketSessionId?: string,
    ideMutation?: IdeMutationCall,
  ): Promise<any | undefined> {
    const handler = this.ideRouteHandlers.get(request.method);
    return handler ? await handler(request, socketSessionId, ideMutation) : undefined;
  }
  async runTrackedIdeMutation<T>(
    socketSessionId: string | undefined,
    run: (call: IdeMutationCall) => Promise<T>,
    ownerSignal?: AbortSignal,
  ): Promise<T> {
    return await this.ideDeviceRoutes.runTrackedIdeMutation(socketSessionId, run, ownerSignal);
  }
  async listBootedDevicesForIdeAction(
    platform: "android" | "ios",
    serial: string,
    signal?: AbortSignal,
  ): Promise<BootedDevice[]> {
    return await this.ideDeviceRoutes.listBootedDevicesForIdeAction(platform, serial, signal);
  }
  async resolveIdeActionDevices(
    platform: "android" | "ios",
    serial: string,
    signal?: AbortSignal,
  ): Promise<
    CanonicalFrameDiscovery & {
      deviceId: string;
    }
  > {
    return await this.ideDeviceRoutes.resolveIdeActionDevices(platform, serial, signal);
  }
  async canonicalFrameDiscovery(
    platform: "android" | "ios",
    rawDevices: readonly BootedDevice[],
    deviceId: string | undefined,
  ): Promise<CanonicalFrameDiscovery> {
    return await this.ideDeviceRoutes.canonicalFrameDiscovery(platform, rawDevices, deviceId);
  }
  async assertFrameTargetProven(
    device: BootedDevice,
    action: string,
    requester?: () => string | undefined,
  ): Promise<void> {
    return await this.ideDeviceRoutes.assertFrameTargetProven(device, action, requester);
  }
  canonicalFrameDeviceId(deviceId: string): string {
    return this.ideDeviceRoutes.canonicalFrameDeviceId(deviceId);
  }
  async runIdeKeyValueMutation(
    platform: "android" | "ios",
    device: BootedDevice,
    appId: string,
    mutation: {
      fileName: string;
      ideMutation: IdeMutationCall | undefined;
      viaSdk: (onDispatch: () => void) => Promise<PreferenceStoreResolution | void>;
      viaDirectFile: (adb: ReturnType<AdbClientFactory["create"]>) => Promise<void>;
    },
  ): Promise<{
    usedDirectFileFallback: boolean;
    resolution: PreferenceStoreResolution | undefined;
  }> {
    return await this.ideDeviceRoutes.runIdeKeyValueMutation(platform, device, appId, mutation);
  }
  async assertSocketToolEnabled(deviceId: string, toolName: string): Promise<void> {
    const registeredTool = daemonToolRegistry().getRegisteredTool(toolName);
    // Direct IDE storage routes have a fixed exact-tool allowlist and may run
    // before any loopback MCP client has populated the process registry.
    const declaredDefault = registeredTool?.defaultEnabled ?? false;
    if (!this.state.daemonState.isInitialized()) {
      await assertToolEnabledForAnySession(toolName, declaredDefault, [undefined], {
        sessionToolSelectionService: this.state.sessionToolSelectionService,
        remediationMethodName: IDE_SET_SESSION_TOOL_ENABLED_METHOD,
      });
      return;
    }
    const sessionManager = this.state.daemonState.getSessionManager();
    // The device's owning session may be a derived `${base}:${label}` label
    // session. Enforce the UNION of base + derived (issue #4611 Gap B, product
    // decision) so a tool is enabled when EITHER grants it — symmetric with the
    // MCP `registerDeviceAware` path. The shared helper resolves the base.
    // The holder is keyed on the pooled canonical id; the frame may name the device by an alias.
    const derivedSessionUuid =
      sessionManager.getSessionForDevice?.(this.callbacks.canonicalFrameDeviceId(deviceId)) ??
      undefined;
    const baseSessionUuid = resolveToolSelectionBaseSessionUuid(derivedSessionUuid, sessionManager);
    await assertToolEnabledForAnySession(
      toolName,
      declaredDefault,
      [baseSessionUuid, derivedSessionUuid],
      {
        sessionToolSelectionService: this.state.sessionToolSelectionService,
        remediationMethodName: IDE_SET_SESSION_TOOL_ENABLED_METHOD,
      },
    );
  }
  private inputDeviceGatingInstance?: InputDeviceGating;
  /** Resolve lazily after the shared callback table has been wired. */
  private get inputDeviceGating(): InputDeviceGating {
    return (this.inputDeviceGatingInstance ??= new InputDeviceGating({
      daemonState: () => this.state.daemonState,
      selectInputTargetDevice: (...args) => this.callbacks.selectInputTargetDevice(...args),
      assertFrameTargetProven: (...args) => this.callbacks.assertFrameTargetProven(...args),
      assertBrokerConnectionInputTarget: (...args) =>
        this.callbacks.assertBrokerConnectionInputTarget(...args),
      captureInputTargetOwner: (...args) => this.callbacks.captureInputTargetOwner(...args),
      assertBrokerConnectionControl: (...args) =>
        this.callbacks.assertBrokerConnectionControl(...args),
      inputTargetOwners: () => this.state.inputTargetOwners,
      discoverInputTargetDevices: (...args) => this.callbacks.discoverInputTargetDevices(...args),
      runTrackedDeviceInput: (...args) => this.callbacks.runTrackedDeviceInput(...args),
      runKeyedMcpForward: (...args) => this.callbacks.runKeyedMcpForward(...args),
      runHeldInputOperation: (...args) => this.callbacks.runHeldInputOperation(...args),
      timer: () => this.state.timer,
      holdDispatchedInputRequest: (...args) => this.callbacks.holdDispatchedInputRequest(...args),
      assertDeviceActionable: (...args) => this.callbacks.assertDeviceActionable(...args),
      assertInputBindingGate: (...args) => this.callbacks.assertInputBindingGate(...args),
      admitInputAsControlCall: (...args) => this.callbacks.admitInputAsControlCall(...args),
      runCancellableInputHandler: (...args) => this.callbacks.runCancellableInputHandler(...args),
      answeringSessionRelease: (...args) => this.callbacks.answeringSessionRelease(...args),
      runFencedInputOperation: (...args) => this.callbacks.runFencedInputOperation(...args),
      canonicalFrameDiscovery: (...args) => this.callbacks.canonicalFrameDiscovery(...args),
      reconcileDiscoveryObservation: (...args) =>
        this.callbacks.reconcileDiscoveryObservation(...args),
    }));
  }
  requireCurrentFrameContext(
    deviceId: string,
    frameContext: string | undefined,
    action: string,
  ): void {
    return this.inputDeviceGating.requireCurrentFrameContext(deviceId, frameContext, action);
  }
  inputRequester(
    request: DaemonRequest,
    socketSessionId: string | undefined,
  ): () => string | undefined {
    return this.inputDeviceGating.inputRequester(request, socketSessionId);
  }
  async resolveInputTargetDevice(
    platform: "android" | "ios",
    deviceId: string | undefined,
    socketSessionId: string | undefined,
    options: InputTargetResolveOptions & { action: InputTargetAction },
  ): Promise<BootedDevice> {
    return await this.inputDeviceGating.resolveInputTargetDevice(
      platform,
      deviceId,
      socketSessionId,
      options,
    );
  }
  assertBrokerConnectionInputTarget(
    socketSessionId: string | undefined,
    action: InputTargetAction,
    deviceId: string,
  ): void {
    return this.inputDeviceGating.assertBrokerConnectionInputTarget(
      socketSessionId,
      action,
      deviceId,
    );
  }
  assertBrokerConnectionControl(
    socketSessionId: string | undefined,
    action: string,
    target: {
      deviceId?: string;
      requesterSessionUuid?: string;
    },
  ): void {
    return this.inputDeviceGating.assertBrokerConnectionControl(socketSessionId, action, target);
  }
  assertBrokerConnectionHostMutation(socketSessionId: string | undefined, action: string): void {
    return this.inputDeviceGating.assertBrokerConnectionHostMutation(socketSessionId, action);
  }
  captureInputTargetOwner(targetDevice: BootedDevice): void {
    return this.inputDeviceGating.captureInputTargetOwner(targetDevice);
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
    return await this.inputDeviceGating.selectInputTargetDevice(
      platform,
      deviceId,
      socketSessionId,
      { action, bypassAndroidDeviceListCache },
    );
  }
  async runTrackedKeyedDeviceInput<T>(
    toolName: string,
    targetDevice: BootedDevice,
    operation: InputOperation<T>,
    gate?: InputDeviceGate,
  ): Promise<T> {
    return await this.inputDeviceGating.runTrackedKeyedDeviceInput(
      toolName,
      targetDevice,
      operation,
      gate,
    );
  }
  inputDeviceGate(
    toolName: string,
    origin: string,
    totalTimeoutMs: number,
    { budgetStartMs, input }: { budgetStartMs: number; input?: InputRequestContext },
  ): InputDeviceGate {
    return this.inputDeviceGating.inputDeviceGate(toolName, origin, totalTimeoutMs, {
      budgetStartMs,
      input,
    });
  }
  async runHeldInputOperation<T>(
    method: string,
    signal: AbortSignal | undefined,
    operation: InputOperation<T>,
    onDispatch: () => void,
  ): Promise<T> {
    return await this.inputDeviceGating.runHeldInputOperation(
      method,
      signal,
      operation,
      onDispatch,
    );
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
    return this.inputDeviceGating.dispatchFencedInput(gesture, signal, timeoutMs, {
      send,
      onDispatch,
    });
  }
  async reconcileDiscoveryObservation(
    devices: readonly BootedDevice[],
    source: string,
  ): Promise<void> {
    return await this.inputDeviceGating.reconcileDiscoveryObservation(devices, source);
  }
  assertDeviceActionable(deviceId: string, purpose: string): void {
    return this.inputDeviceGating.assertDeviceActionable(deviceId, purpose);
  }
  async assertInputBindingGate(
    toolName: string,
    targetDevice: BootedDevice,
    requester: (() => string | undefined) | undefined,
  ): Promise<void> {
    return await this.inputDeviceGating.assertInputBindingGate(toolName, targetDevice, requester);
  }
  async runTrackedDeviceInput<T>(
    toolName: string,
    targetDevice: BootedDevice,
    operation: InputOperation<T>,
    options: { ownerSignal?: AbortSignal; requester?: () => string | undefined } = {},
  ): Promise<T> {
    return await this.inputDeviceGating.runTrackedDeviceInput(
      toolName,
      targetDevice,
      operation,
      options,
    );
  }
  async admitInputAsControlCall(
    execution: ActiveExecution,
    deviceId: string,
    holderSessionUuid: string | undefined,
    ownerSignal: AbortSignal | undefined,
  ): Promise<void> {
    return await this.inputDeviceGating.admitInputAsControlCall(
      execution,
      deviceId,
      holderSessionUuid,
      ownerSignal,
    );
  }
  async answeringSessionRelease<T>(
    execution: Pick<ActiveExecution, "cancelReason"> & Partial<Pick<ActiveExecution, "toolName">>,
    run: () => Promise<T>,
  ): Promise<T> {
    return await this.inputDeviceGating.answeringSessionRelease(execution, run);
  }
  runFencedInputOperation<T>(
    trackerSignal: AbortSignal,
    ownerSignal: AbortSignal | undefined,
    operation: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.inputDeviceGating.runFencedInputOperation(trackerSignal, ownerSignal, operation);
  }
  async discoverInputTargetDevices(
    platform: "android" | "ios",
    action: InputTargetAction,
    bypassAndroidDeviceListCache: boolean,
    deviceId: string | undefined,
  ): Promise<CanonicalFrameDiscovery> {
    return await this.inputDeviceGating.discoverInputTargetDevices(
      platform,
      action,
      bypassAndroidDeviceListCache,
      deviceId,
    );
  }
  mcpRequestOptions(
    timeoutMs: number,
    signal?: AbortSignal,
  ): {
    timeout: number;
    signal?: AbortSignal;
  } {
    return signal ? { timeout: timeoutMs, signal } : { timeout: timeoutMs };
  }
  combineMcpRequestSignals(
    ownerSignal: AbortSignal | undefined,
    timeoutSignal: AbortSignal,
  ): AbortSignal {
    return ownerSignal ? AbortSignal.any([ownerSignal, timeoutSignal]) : timeoutSignal;
  }
}
