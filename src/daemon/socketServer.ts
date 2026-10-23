import { CONTROL_SOCKET_MAX_FRAME_BYTES } from "./socketServer/LineFramer";
import { shapeToolCallError } from "./shapeToolCallError";

import { type ListChangedKind } from "./listChangedBroadcast";

import type { BootedDevice } from "../models";
import { type ActiveExecution } from "./executionTracker";

import {
  DAEMON_ACCEPTANCE_RESTART_ADMISSION_TTL_MS,
  DAEMON_MAINTENANCE_ADMISSION_TTL_MS,
} from "./socketServer/restartAdmission";

import { mcpRequestFailureDetails } from "./socketServer/errorFrames";
import { interceptableMethod } from "./interceptableMethod";

import type { UnixSocketServerTestHooks } from "./socketServer/unixSocketServerTestHooks";

import { type McpClientFactory } from "./socketServer/forwardSessionKey";
import { type McpForwardChainWait } from "./socketServer/keyedSerialQueue";

import { type InputDeviceGate, type InputOperation } from "./socketServer/inputDeviceGating";

import {
  SocketServerRuntime,
  type SocketServerConstructorArgs,
} from "./socketServerParts/SocketServerRuntime";
import { createSocketServerOperations } from "./socketServerParts/createSocketServerOperations";
import type { SocketServerOperations } from "./socketServerParts/socketServerOperations";

export { DAEMON_ACCEPTANCE_RESTART_ADMISSION_TTL_MS, DAEMON_MAINTENANCE_ADMISSION_TTL_MS };
export { strokeAdmissionEndedError, type StrokeAdmission } from "./socketServer/inputStrokes";
export { mcpRequestFailureDetails };
export type { McpClientFactory };
export type { ListChangedKind };
export { DaemonSocketQueueOverflowError } from "./socketServerParts/DaemonSocketQueueOverflowError";
export {
  MCP_FORWARD_START_HEADROOM_MS,
  type SocketReclaimLock,
  type SocketOwnerLiveness,
  type SocketOwnerStatus,
  type AppendTextInput,
  type McpForwardRoute,
  type SocketFrameTraceEvent,
} from "./socketServerParts/socketServerContracts";
/** Unix control socket composition root. Delegates preserve subclass overrides and test seams. */
export class UnixSocketServer {
  private readonly runtime: SocketServerRuntime;
  private readonly operations: SocketServerOperations;
  private readonly callbacks: SocketServerOperations;
  constructor(...args: SocketServerConstructorArgs) {
    this.runtime = new SocketServerRuntime(
      args,
      () => this.operations,
      shapeToolCallError,
      () => this.maxInboundFrameBytes,
    );
    const parts = createSocketServerOperations(this.runtime, {
      start: (...args) => this.start(...args),
      startDetached: (...args) => this.startDetached(...args),
      stopAcceptingAndFanOut: (...args) => this.stopAcceptingAndFanOut(...args),
      handleConnection: (...args) => this.handleConnection(...args),
      releaseSocketSession: (...args) => this.releaseSocketSession(...args),
      abortMcpRequests: (...args) => this.abortMcpRequests(...args),
      mcpRequestSignal: (...args) => this.mcpRequestSignal(...args),
      broadcastResourceUpdated: (...args) => this.broadcastResourceUpdated(...args),
      pushProgressNotification: (...args) => this.pushProgressNotification(...args),
      writeFrameData: (...args) => this.writeFrameData(...args),
      handleRequest: (...args) => this.handleRequest(...args),
      mcpForwardFailureResponse: (...args) => this.mcpForwardFailureResponse(...args),
      requireRemainingMcpForwardBudget: (...args) => this.requireRemainingMcpForwardBudget(...args),
      runKeyedMcpForward: (...args) => this.runKeyedMcpForward(...args),
      getMcpForwardRoute: (...args) => this.getMcpForwardRoute(...args),
      restoreSelectorSessions: (...args) => this.restoreSelectorSessions(...args),
      recordBoundMcpClientKey: (...args) => this.recordBoundMcpClientKey(...args),
      clearBoundMcpClientKey: (...args) => this.clearBoundMcpClientKey(...args),
      forwardMcpRequest: (...args) => this.forwardMcpRequest(...args),
      remainingMcpForwardBudget: (...args) => this.remainingMcpForwardBudget(...args),
      getRequestArgumentScopeKey: (...args) => this.getRequestArgumentScopeKey(...args),
      handleLocalSocketRequest: (...args) => this.handleLocalSocketRequest(...args),
      handleIdeSocketRequest: (...args) => this.handleIdeSocketRequest(...args),
      listBootedDevicesForIdeAction: (...args) => this.listBootedDevicesForIdeAction(...args),
      runIdeKeyValueMutation: (...args) => this.runIdeKeyValueMutation(...args),
      toIosRunnerCoordinates: (...args) => this.toIosRunnerCoordinates(...args),
      handleInputTap: (...args) => this.handleInputTap(...args),
      handleInputSwipe: (...args) => this.handleInputSwipe(...args),
      handleInputGesture: (...args) => this.handleInputGesture(...args),
      captureStrokeAdmission: (...args) => this.captureStrokeAdmission(...args),
      strokeAdmissionStillHolds: (...args) => this.strokeAdmissionStillHolds(...args),
      liftSessionlessStrokesOn: (...args) => this.liftSessionlessStrokesOn(...args),
      liftStrokesHeldByOn: (...args) => this.liftStrokesHeldByOn(...args),
      liftStrokesHeldBy: (...args) => this.liftStrokesHeldBy(...args),
      handleInputTypeText: (...args) => this.handleInputTypeText(...args),
      handleInputPressButton: (...args) => this.handleInputPressButton(...args),
      handleInputKey: (...args) => this.handleInputKey(...args),
      requireCurrentFrameContext: (...args) => this.requireCurrentFrameContext(...args),
      resolveInputTargetDevice: (...args) => this.resolveInputTargetDevice(...args),
      captureInputTargetOwner: (...args) => this.captureInputTargetOwner(...args),
      runTrackedKeyedDeviceInput: (...args) => this.runTrackedKeyedDeviceInput(...args),
      dispatchFencedInput: (...args) => this.dispatchFencedInput(...args),
      runTrackedDeviceInput: (...args) => this.runTrackedDeviceInput(...args),
      answeringSessionRelease: (...args) => this.answeringSessionRelease(...args),
      handleIdeRequest: (...args) => this.handleIdeRequest(...args),
      withSocketSessionAutolockKey: (...args) => this.withSocketSessionAutolockKey(...args),
      scheduleForwardKeyIdle: (...args) => this.scheduleForwardKeyIdle(...args),
      clearForwardKeyIdleTimer: (...args) => this.clearForwardKeyIdleTimer(...args),
      evictDeviceInputCache: (...args) => this.evictDeviceInputCache(...args),
      isListening: (...args) => this.isListening(...args),
      getClientConnectionCount: (...args) => this.getClientConnectionCount(...args),
      getAcceptedClientConnectionCount: (...args) => this.getAcceptedClientConnectionCount(...args),
      quiesce: (...args) => this.quiesce(...args),
      drainSessionReleaseNotifications: (...args) => this.drainSessionReleaseNotifications(...args),
      close: (...args) => this.close(...args),
    });
    this.operations = parts.implementations;
    this.callbacks = parts.callbacks;
  }
  protected get server(): SocketServerRuntime["server"] {
    return this.runtime.server;
  }
  protected set server(value: SocketServerRuntime["server"]) {
    this.runtime.server = value;
  }
  protected get acceptingRequests(): SocketServerRuntime["acceptingRequests"] {
    return this.runtime.acceptingRequests;
  }
  protected set acceptingRequests(value: SocketServerRuntime["acceptingRequests"]) {
    this.runtime.acceptingRequests = value;
  }
  protected readonly maxInboundFrameBytes = CONTROL_SOCKET_MAX_FRAME_BYTES;
  protected get sessions(): SocketServerRuntime["sessions"] {
    return this.runtime.sessions;
  }
  protected set sessions(value: SocketServerRuntime["sessions"]) {
    this.runtime.sessions = value;
  }
  protected get clientSockets(): SocketServerRuntime["clientSockets"] {
    return this.runtime.clientSockets;
  }
  protected set clientSockets(value: SocketServerRuntime["clientSockets"]) {
    this.runtime.clientSockets = value;
  }
  protected get activeRequestHandlers(): SocketServerRuntime["activeRequestHandlers"] {
    return this.runtime.activeRequestHandlers;
  }
  protected set activeRequestHandlers(value: SocketServerRuntime["activeRequestHandlers"]) {
    this.runtime.activeRequestHandlers = value;
  }
  protected get pendingSocketRequests(): SocketServerRuntime["pendingSocketRequests"] {
    return this.runtime.pendingSocketRequests;
  }
  protected set pendingSocketRequests(value: SocketServerRuntime["pendingSocketRequests"]) {
    this.runtime.pendingSocketRequests = value;
  }
  protected get notificationSubscribers(): SocketServerRuntime["notificationSubscribers"] {
    return this.runtime.notificationSubscribers;
  }
  protected set notificationSubscribers(value: SocketServerRuntime["notificationSubscribers"]) {
    this.runtime.notificationSubscribers = value;
  }
  protected get resourceSubscriptions(): SocketServerRuntime["resourceSubscriptions"] {
    return this.runtime.resourceSubscriptions;
  }
  protected get listChangedUnsubscribe(): SocketServerRuntime["listChangedUnsubscribe"] {
    return this.runtime.listChangedUnsubscribe;
  }
  protected set listChangedUnsubscribe(value: SocketServerRuntime["listChangedUnsubscribe"]) {
    this.runtime.listChangedUnsubscribe = value;
  }
  protected get sessionReleaseUnsubscribe(): SocketServerRuntime["sessionReleaseUnsubscribe"] {
    return this.runtime.sessionReleaseUnsubscribe;
  }
  protected set sessionReleaseUnsubscribe(value: SocketServerRuntime["sessionReleaseUnsubscribe"]) {
    this.runtime.sessionReleaseUnsubscribe = value;
  }
  protected get boundMcpClientKeysBySocketSession(): SocketServerRuntime["boundMcpClientKeysBySocketSession"] {
    return this.runtime.boundMcpClientKeysBySocketSession;
  }
  protected set boundMcpClientKeysBySocketSession(
    value: SocketServerRuntime["boundMcpClientKeysBySocketSession"],
  ) {
    this.runtime.boundMcpClientKeysBySocketSession = value;
  }
  protected get mcpForwardTails(): SocketServerRuntime["mcpForwardTails"] {
    return this.runtime.mcpForwardTails;
  }
  protected set mcpForwardTails(value: SocketServerRuntime["mcpForwardTails"]) {
    this.runtime.mcpForwardTails = value;
  }
  get deviceReadToolCallClassifier(): SocketServerRuntime["deviceReadToolCallClassifier"] {
    return this.runtime.deviceReadToolCallClassifier;
  }
  set deviceReadToolCallClassifier(value: SocketServerRuntime["deviceReadToolCallClassifier"]) {
    this.runtime.deviceReadToolCallClassifier = value;
  }
  get mcpClientFactory(): SocketServerRuntime["mcpClientFactory"] {
    return this.runtime.mcpClientFactory;
  }
  set mcpClientFactory(value: SocketServerRuntime["mcpClientFactory"]) {
    this.runtime.mcpClientFactory = value;
  }
  get releaseToolCallRecording(): SocketServerRuntime["releaseToolCallRecording"] {
    return this.runtime.releaseToolCallRecording;
  }
  set releaseToolCallRecording(value: SocketServerRuntime["releaseToolCallRecording"]) {
    this.runtime.releaseToolCallRecording = value;
  }
  get forgetSessionToolBindings(): SocketServerRuntime["forgetSessionToolBindings"] {
    return this.runtime.forgetSessionToolBindings;
  }
  set forgetSessionToolBindings(value: SocketServerRuntime["forgetSessionToolBindings"]) {
    this.runtime.forgetSessionToolBindings = value;
  }
  get appendTextFactory(): SocketServerRuntime["appendTextFactory"] {
    return this.runtime.appendTextFactory;
  }
  set appendTextFactory(value: SocketServerRuntime["appendTextFactory"]) {
    this.runtime.appendTextFactory = value;
  }
  protected get ownedGestures(): SocketServerRuntime["ownedGestures"] {
    return this.runtime.ownedGestures;
  }
  start(
    ...args: Parameters<SocketServerOperations["start"]>
  ): ReturnType<SocketServerOperations["start"]> {
    return this.operations.start(...args);
  }
  startDetached(
    ...args: Parameters<SocketServerOperations["startDetached"]>
  ): ReturnType<SocketServerOperations["startDetached"]> {
    return this.operations.startDetached(...args);
  }
  stopAcceptingAndFanOut(
    ...args: Parameters<SocketServerOperations["stopAcceptingAndFanOut"]>
  ): ReturnType<SocketServerOperations["stopAcceptingAndFanOut"]> {
    return this.operations.stopAcceptingAndFanOut(...args);
  }
  protected handleConnection(
    ...args: Parameters<SocketServerOperations["handleConnection"]>
  ): ReturnType<SocketServerOperations["handleConnection"]> {
    return this.operations.handleConnection(...args);
  }
  protected releaseSocketSession(
    ...args: Parameters<SocketServerOperations["releaseSocketSession"]>
  ): ReturnType<SocketServerOperations["releaseSocketSession"]> {
    return this.operations.releaseSocketSession(...args);
  }
  protected abortMcpRequests(
    ...args: Parameters<SocketServerOperations["abortMcpRequests"]>
  ): ReturnType<SocketServerOperations["abortMcpRequests"]> {
    return this.operations.abortMcpRequests(...args);
  }
  protected mcpRequestSignal(
    ...args: Parameters<SocketServerOperations["mcpRequestSignal"]>
  ): ReturnType<SocketServerOperations["mcpRequestSignal"]> {
    return this.operations.mcpRequestSignal(...args);
  }
  protected broadcastResourceUpdated(
    ...args: Parameters<SocketServerOperations["broadcastResourceUpdated"]>
  ): ReturnType<SocketServerOperations["broadcastResourceUpdated"]> {
    return this.operations.broadcastResourceUpdated(...args);
  }
  protected pushProgressNotification(
    ...args: Parameters<SocketServerOperations["pushProgressNotification"]>
  ): ReturnType<SocketServerOperations["pushProgressNotification"]> {
    return this.operations.pushProgressNotification(...args);
  }
  protected writeFrameData(
    ...args: Parameters<SocketServerOperations["writeFrameData"]>
  ): ReturnType<SocketServerOperations["writeFrameData"]> {
    return this.operations.writeFrameData(...args);
  }
  protected handleRequest(
    ...args: Parameters<SocketServerOperations["handleRequest"]>
  ): ReturnType<SocketServerOperations["handleRequest"]> {
    return this.operations.handleRequest(...args);
  }
  protected mcpForwardFailureResponse(
    ...args: Parameters<SocketServerOperations["mcpForwardFailureResponse"]>
  ): ReturnType<SocketServerOperations["mcpForwardFailureResponse"]> {
    return this.operations.mcpForwardFailureResponse(...args);
  }
  protected requireRemainingMcpForwardBudget(
    ...args: Parameters<SocketServerOperations["requireRemainingMcpForwardBudget"]>
  ): ReturnType<SocketServerOperations["requireRemainingMcpForwardBudget"]> {
    return this.operations.requireRemainingMcpForwardBudget(...args);
  }
  protected runKeyedMcpForward<T>(
    executionKey: string,
    fn: () => Promise<T>,
    idleCloseKey?: string,
    chainWait?: McpForwardChainWait,
  ): Promise<T> {
    return this.operations.runKeyedMcpForward<T>(executionKey, fn, idleCloseKey, chainWait);
  }
  protected getMcpForwardRoute(
    ...args: Parameters<SocketServerOperations["getMcpForwardRoute"]>
  ): ReturnType<SocketServerOperations["getMcpForwardRoute"]> {
    return this.operations.getMcpForwardRoute(...args);
  }
  protected restoreSelectorSessions(
    ...args: Parameters<SocketServerOperations["restoreSelectorSessions"]>
  ): ReturnType<SocketServerOperations["restoreSelectorSessions"]> {
    return this.operations.restoreSelectorSessions(...args);
  }
  protected recordBoundMcpClientKey(
    ...args: Parameters<SocketServerOperations["recordBoundMcpClientKey"]>
  ): ReturnType<SocketServerOperations["recordBoundMcpClientKey"]> {
    return this.operations.recordBoundMcpClientKey(...args);
  }
  protected clearBoundMcpClientKey(
    ...args: Parameters<SocketServerOperations["clearBoundMcpClientKey"]>
  ): ReturnType<SocketServerOperations["clearBoundMcpClientKey"]> {
    return this.operations.clearBoundMcpClientKey(...args);
  }
  protected forwardMcpRequest(
    ...args: Parameters<SocketServerOperations["forwardMcpRequest"]>
  ): ReturnType<SocketServerOperations["forwardMcpRequest"]> {
    return this.operations.forwardMcpRequest(...args);
  }
  protected remainingMcpForwardBudget(
    ...args: Parameters<SocketServerOperations["remainingMcpForwardBudget"]>
  ): ReturnType<SocketServerOperations["remainingMcpForwardBudget"]> {
    return this.operations.remainingMcpForwardBudget(...args);
  }
  protected getRequestArgumentScopeKey(
    ...args: Parameters<SocketServerOperations["getRequestArgumentScopeKey"]>
  ): ReturnType<SocketServerOperations["getRequestArgumentScopeKey"]> {
    return this.operations.getRequestArgumentScopeKey(...args);
  }
  protected handleLocalSocketRequest(
    ...args: Parameters<SocketServerOperations["handleLocalSocketRequest"]>
  ): ReturnType<SocketServerOperations["handleLocalSocketRequest"]> {
    return this.operations.handleLocalSocketRequest(...args);
  }
  protected handleIdeSocketRequest(
    ...args: Parameters<SocketServerOperations["handleIdeSocketRequest"]>
  ): ReturnType<SocketServerOperations["handleIdeSocketRequest"]> {
    return this.operations.handleIdeSocketRequest(...args);
  }
  protected listBootedDevicesForIdeAction(
    ...args: Parameters<SocketServerOperations["listBootedDevicesForIdeAction"]>
  ): ReturnType<SocketServerOperations["listBootedDevicesForIdeAction"]> {
    return this.operations.listBootedDevicesForIdeAction(...args);
  }
  protected runIdeKeyValueMutation(
    ...args: Parameters<SocketServerOperations["runIdeKeyValueMutation"]>
  ): ReturnType<SocketServerOperations["runIdeKeyValueMutation"]> {
    return this.operations.runIdeKeyValueMutation(...args);
  }
  protected toIosRunnerCoordinates(
    ...args: Parameters<SocketServerOperations["toIosRunnerCoordinates"]>
  ): ReturnType<SocketServerOperations["toIosRunnerCoordinates"]> {
    return this.operations.toIosRunnerCoordinates(...args);
  }
  protected handleInputTap(
    ...args: Parameters<SocketServerOperations["handleInputTap"]>
  ): ReturnType<SocketServerOperations["handleInputTap"]> {
    return this.operations.handleInputTap(...args);
  }
  protected handleInputSwipe(
    ...args: Parameters<SocketServerOperations["handleInputSwipe"]>
  ): ReturnType<SocketServerOperations["handleInputSwipe"]> {
    return this.operations.handleInputSwipe(...args);
  }
  protected handleInputGesture(
    ...args: Parameters<SocketServerOperations["handleInputGesture"]>
  ): ReturnType<SocketServerOperations["handleInputGesture"]> {
    return this.operations.handleInputGesture(...args);
  }
  protected captureStrokeAdmission(
    ...args: Parameters<SocketServerOperations["captureStrokeAdmission"]>
  ): ReturnType<SocketServerOperations["captureStrokeAdmission"]> {
    return this.operations.captureStrokeAdmission(...args);
  }
  protected strokeAdmissionStillHolds(
    ...args: Parameters<SocketServerOperations["strokeAdmissionStillHolds"]>
  ): ReturnType<SocketServerOperations["strokeAdmissionStillHolds"]> {
    return this.operations.strokeAdmissionStillHolds(...args);
  }
  liftSessionlessStrokesOn(
    ...args: Parameters<SocketServerOperations["liftSessionlessStrokesOn"]>
  ): ReturnType<SocketServerOperations["liftSessionlessStrokesOn"]> {
    return this.operations.liftSessionlessStrokesOn(...args);
  }
  liftStrokesHeldByOn(
    ...args: Parameters<SocketServerOperations["liftStrokesHeldByOn"]>
  ): ReturnType<SocketServerOperations["liftStrokesHeldByOn"]> {
    return this.operations.liftStrokesHeldByOn(...args);
  }
  protected liftStrokesHeldBy(
    ...args: Parameters<SocketServerOperations["liftStrokesHeldBy"]>
  ): ReturnType<SocketServerOperations["liftStrokesHeldBy"]> {
    return this.operations.liftStrokesHeldBy(...args);
  }
  protected handleInputTypeText(
    ...args: Parameters<SocketServerOperations["handleInputTypeText"]>
  ): ReturnType<SocketServerOperations["handleInputTypeText"]> {
    return this.operations.handleInputTypeText(...args);
  }
  protected handleInputPressButton(
    ...args: Parameters<SocketServerOperations["handleInputPressButton"]>
  ): ReturnType<SocketServerOperations["handleInputPressButton"]> {
    return this.operations.handleInputPressButton(...args);
  }
  protected handleInputKey(
    ...args: Parameters<SocketServerOperations["handleInputKey"]>
  ): ReturnType<SocketServerOperations["handleInputKey"]> {
    return this.operations.handleInputKey(...args);
  }
  protected requireCurrentFrameContext(
    ...args: Parameters<SocketServerOperations["requireCurrentFrameContext"]>
  ): ReturnType<SocketServerOperations["requireCurrentFrameContext"]> {
    return this.operations.requireCurrentFrameContext(...args);
  }
  protected resolveInputTargetDevice(
    ...args: Parameters<SocketServerOperations["resolveInputTargetDevice"]>
  ): ReturnType<SocketServerOperations["resolveInputTargetDevice"]> {
    return this.operations.resolveInputTargetDevice(...args);
  }
  protected captureInputTargetOwner(
    ...args: Parameters<SocketServerOperations["captureInputTargetOwner"]>
  ): ReturnType<SocketServerOperations["captureInputTargetOwner"]> {
    return this.operations.captureInputTargetOwner(...args);
  }
  protected runTrackedKeyedDeviceInput<T>(
    toolName: string,
    targetDevice: BootedDevice,
    operation: InputOperation<T>,
    gate?: InputDeviceGate,
  ): Promise<T> {
    return this.operations.runTrackedKeyedDeviceInput<T>(toolName, targetDevice, operation, gate);
  }
  protected dispatchFencedInput<T>(
    gesture: "Tap" | "Swipe",
    signal: AbortSignal | undefined,
    timeoutMs: number,
    send: (fenced: AbortSignal | undefined, onDispatch: () => void) => Promise<T>,
    onDispatch?: () => void,
  ): Promise<T> {
    return this.operations.dispatchFencedInput<T>(gesture, signal, timeoutMs, send, onDispatch);
  }
  protected runTrackedDeviceInput<T>(
    toolName: string,
    targetDevice: BootedDevice,
    operation: InputOperation<T>,
    ownerSignal?: AbortSignal,
    requester?: () => string | undefined,
  ): Promise<T> {
    return this.operations.runTrackedDeviceInput<T>(
      toolName,
      targetDevice,
      operation,
      ownerSignal,
      requester,
    );
  }
  protected answeringSessionRelease<T>(
    execution: Pick<ActiveExecution, "cancelReason"> & Partial<Pick<ActiveExecution, "toolName">>,
    run: () => Promise<T>,
  ): Promise<T> {
    return this.operations.answeringSessionRelease<T>(execution, run);
  }
  protected handleIdeRequest(
    ...args: Parameters<SocketServerOperations["handleIdeRequest"]>
  ): ReturnType<SocketServerOperations["handleIdeRequest"]> {
    return this.operations.handleIdeRequest(...args);
  }
  protected withSocketSessionAutolockKey(
    ...args: Parameters<SocketServerOperations["withSocketSessionAutolockKey"]>
  ): ReturnType<SocketServerOperations["withSocketSessionAutolockKey"]> {
    return this.operations.withSocketSessionAutolockKey(...args);
  }
  protected scheduleForwardKeyIdle(
    ...args: Parameters<SocketServerOperations["scheduleForwardKeyIdle"]>
  ): ReturnType<SocketServerOperations["scheduleForwardKeyIdle"]> {
    return this.operations.scheduleForwardKeyIdle(...args);
  }
  protected clearForwardKeyIdleTimer(
    ...args: Parameters<SocketServerOperations["clearForwardKeyIdleTimer"]>
  ): ReturnType<SocketServerOperations["clearForwardKeyIdleTimer"]> {
    return this.operations.clearForwardKeyIdleTimer(...args);
  }
  evictDeviceInputCache(
    ...args: Parameters<SocketServerOperations["evictDeviceInputCache"]>
  ): ReturnType<SocketServerOperations["evictDeviceInputCache"]> {
    return this.operations.evictDeviceInputCache(...args);
  }
  isListening(
    ...args: Parameters<SocketServerOperations["isListening"]>
  ): ReturnType<SocketServerOperations["isListening"]> {
    return this.operations.isListening(...args);
  }
  getClientConnectionCount(
    ...args: Parameters<SocketServerOperations["getClientConnectionCount"]>
  ): ReturnType<SocketServerOperations["getClientConnectionCount"]> {
    return this.operations.getClientConnectionCount(...args);
  }
  getAcceptedClientConnectionCount(
    ...args: Parameters<SocketServerOperations["getAcceptedClientConnectionCount"]>
  ): ReturnType<SocketServerOperations["getAcceptedClientConnectionCount"]> {
    return this.operations.getAcceptedClientConnectionCount(...args);
  }
  quiesce(
    ...args: Parameters<SocketServerOperations["quiesce"]>
  ): ReturnType<SocketServerOperations["quiesce"]> {
    return this.operations.quiesce(...args);
  }
  drainSessionReleaseNotifications(
    ...args: Parameters<SocketServerOperations["drainSessionReleaseNotifications"]>
  ): ReturnType<SocketServerOperations["drainSessionReleaseNotifications"]> {
    return this.operations.drainSessionReleaseNotifications(...args);
  }
  close(
    ...args: Parameters<SocketServerOperations["close"]>
  ): ReturnType<SocketServerOperations["close"]> {
    return this.operations.close(...args);
  }
  /** Typed access to the MCP forward-routing internals for daemon integration tests. */
  get testHooks(): UnixSocketServerTestHooks {
    const server = this;
    return {
      sessions: this.runtime.sessions,
      get acceptingRequests() {
        return server.runtime.acceptingRequests;
      },
      set acceptingRequests(value: boolean) {
        server.runtime.acceptingRequests = value;
      },
      input: this.callbacks,
      ide: this.callbacks,
      transport: this.callbacks,
      routing: this.callbacks,
      release: this.callbacks,
      restoreSelectorSessions: (args, id) => this.callbacks.restoreSelectorSessions(args, id),
      getMcpForwardRoute: (request, id) => this.callbacks.getMcpForwardRoute(request, id),
      withSocketSessionAutolockKey: (...args) =>
        this.callbacks.withSocketSessionAutolockKey(...args),
      recordBoundMcpClientKey: (...args) => this.callbacks.recordBoundMcpClientKey(...args),
      boundMcpClientFor: (id) => this.runtime.boundMcpClientKeysBySocketSession.get(id),
      requireCurrentFrameContext: (...args) => this.callbacks.requireCurrentFrameContext(...args),
      broadcastListChanged: interceptableMethod(
        () => this.callbacks.broadcastListChanged.bind(this),
        (replacement) => {
          this.callbacks.broadcastListChanged = replacement;
        },
      ),
      waitForStartup: interceptableMethod(
        () => this.callbacks.waitForStartup.bind(this),
        (replacement) => (this.callbacks.waitForStartup = replacement),
      ),
    };
  }
}
