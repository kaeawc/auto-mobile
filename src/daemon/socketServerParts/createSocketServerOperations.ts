import { SocketLifecycle } from "./SocketLifecycle";
import { SocketTransport } from "./SocketTransport";
import { SocketAdmission } from "./SocketAdmission";
import { McpExecution } from "./McpExecution";
import { McpRouting } from "./McpRouting";
import { McpBindings } from "./McpBindings";
import { SocketIdeRoutes } from "./SocketIdeRoutes";
import { SocketInput } from "./SocketInput";
import { SocketTextInput } from "./SocketTextInput";
import type { SocketServerRuntime } from "./SocketServerRuntime";
import type { SocketServerOperations, SocketServerOverrides } from "./socketServerOperations";

function bindSocketLifecycle(
  target: SocketLifecycle,
): Pick<SocketLifecycle, keyof SocketLifecycle> {
  return {
    start: target.start.bind(target),
    startDetached: target.startDetached.bind(target),
    stopAcceptingAndFanOut: target.stopAcceptingAndFanOut.bind(target),
    beginAccepting: target.beginAccepting.bind(target),
    connectionHandlerWithFanOut: target.connectionHandlerWithFanOut.bind(target),
    reclaimExistingSocketBeforeBind: target.reclaimExistingSocketBeforeBind.bind(target),
    isListening: target.isListening.bind(target),
    getClientConnectionCount: target.getClientConnectionCount.bind(target),
    getAcceptedClientConnectionCount: target.getAcceptedClientConnectionCount.bind(target),
    quiesce: target.quiesce.bind(target),
    drainSessionReleaseNotifications: target.drainSessionReleaseNotifications.bind(target),
    close: target.close.bind(target),
    writeShutdownSocketResponse: target.writeShutdownSocketResponse.bind(target),
    closeListeningServer: target.closeListeningServer.bind(target),
    destroyClientSockets: target.destroyClientSockets.bind(target),
    drainActiveRequestHandlers: target.drainActiveRequestHandlers.bind(target),
  };
}

function bindSocketTransport(
  target: SocketTransport,
): Pick<SocketTransport, keyof SocketTransport> {
  return {
    handleConnection: target.handleConnection.bind(target),
    connectionFor: target.connectionFor.bind(target),
    rejectOversizedFrame: target.rejectOversizedFrame.bind(target),
    hasLiveSocketRequest: target.hasLiveSocketRequest.bind(target),
    processSocketRequestLine: target.processSocketRequestLine.bind(target),
    writeTerminalSocketResponse: target.writeTerminalSocketResponse.bind(target),
    withCanonicalToolCallDeviceIds: target.withCanonicalToolCallDeviceIds.bind(target),
    frameDeviceId: target.frameDeviceId.bind(target),
    traceFrame: target.traceFrame.bind(target),
    releaseSocketSession: target.releaseSocketSession.bind(target),
    forgetLateSessionToolBindings: target.forgetLateSessionToolBindings.bind(target),
    trackRequestHandler: target.trackRequestHandler.bind(target),
    abortMcpRequests: target.abortMcpRequests.bind(target),
    abortRequestControllers: target.abortRequestControllers.bind(target),
    mcpRequestSignal: target.mcpRequestSignal.bind(target),
    isMcpRequestOwnerCurrent: target.isMcpRequestOwnerCurrent.bind(target),
    broadcastListChanged: target.broadcastListChanged.bind(target),
    broadcastResourceUpdated: target.broadcastResourceUpdated.bind(target),
    handleResourceSubscription: target.handleResourceSubscription.bind(target),
    broadcastSessionDeviceRebound: target.broadcastSessionDeviceRebound.bind(target),
    broadcastSessionReleased: target.broadcastSessionReleased.bind(target),
    pushProgressNotification: target.pushProgressNotification.bind(target),
    writeFrame: target.writeFrame.bind(target),
    writeFrameData: target.writeFrameData.bind(target),
  };
}

function bindSocketAdmission(
  target: SocketAdmission,
): Pick<SocketAdmission, keyof SocketAdmission> {
  return {
    handleRequest: target.handleRequest.bind(target),
    unqueuedRequest: target.unqueuedRequest.bind(target),
    relayTaskRequest: target.relayTaskRequest.bind(target),
    runProvisionBarrier: target.runProvisionBarrier.bind(target),
    shuttingDownBeforeStartResponse: target.shuttingDownBeforeStartResponse.bind(target),
    isProvisionDeviceCall: target.isProvisionDeviceCall.bind(target),
    provisionCancellationReply: target.provisionCancellationReply.bind(target),
    mcpForwardFailureResponse: target.mcpForwardFailureResponse.bind(target),
    waitForStartup: target.waitForStartup.bind(target),
    registerRequestCancellation: target.registerRequestCancellation.bind(target),
    cancelSocketRequest: target.cancelSocketRequest.bind(target),
    requireRemainingMcpForwardBudget: target.requireRemainingMcpForwardBudget.bind(target),
    socketAdmissionCancellation: target.socketAdmissionCancellation.bind(target),
    runCancellableInputHandler: target.runCancellableInputHandler.bind(target),
    runCancellableQueuedHandler: target.runCancellableQueuedHandler.bind(target),
  };
}

function bindMcpExecution(target: McpExecution): Pick<McpExecution, keyof McpExecution> {
  return {
    forgetSocketDiscovery: target.forgetSocketDiscovery.bind(target),
    rejectOnHandshakeMismatch: target.rejectOnHandshakeMismatch.bind(target),
    runKeyedMcpForward: target.runKeyedMcpForward.bind(target),
    runMcpForwardForCurrentRoute: target.runMcpForwardForCurrentRoute.bind(target),
    runMcpForwardAttempt: target.runMcpForwardAttempt.bind(target),
    forwardMcpRequest: target.forwardMcpRequest.bind(target),
    remainingMcpForwardBudget: target.remainingMcpForwardBudget.bind(target),
    wasRequestSessionActive: target.wasRequestSessionActive.bind(target),
    describeMcpForwardRequest: target.describeMcpForwardRequest.bind(target),
    daemonGenerationMatches: target.daemonGenerationMatches.bind(target),
    currentGenerationIdentity: target.currentGenerationIdentity.bind(target),
    republishDaemonIdentity: target.republishDaemonIdentity.bind(target),
    publishIdentity: target.publishIdentity.bind(target),
    requireFeatureFlagService: target.requireFeatureFlagService.bind(target),
    handleIdeRequest: target.handleIdeRequest.bind(target),
    textForwardFailure: target.textForwardFailure.bind(target),
    traceCallTool: target.traceCallTool.bind(target),
    withLiveDeadlineKey: target.withLiveDeadlineKey.bind(target),
    withSocketSessionAutolockKey: target.withSocketSessionAutolockKey.bind(target),
    recordOneShotCliConnection: target.recordOneShotCliConnection.bind(target),
    oneShotCliMarker: target.oneShotCliMarker.bind(target),
    createMcpClient: target.createMcpClient.bind(target),
    scheduleForwardKeyIdle: target.scheduleForwardKeyIdle.bind(target),
    clearForwardKeyIdleTimer: target.clearForwardKeyIdleTimer.bind(target),
    onForwardKeyIdle: target.onForwardKeyIdle.bind(target),
  };
}

function bindMcpRouting(target: McpRouting): Pick<McpRouting, keyof McpRouting> {
  return {
    getMcpForwardRoute: target.getMcpForwardRoute.bind(target),
    withDeviceReadLane: target.withDeviceReadLane.bind(target),
    getDeviceLabelSession: target.getDeviceLabelSession.bind(target),
    isDeviceReadToolCall: target.isDeviceReadToolCall.bind(target),
    getDeviceHolderSession: target.getDeviceHolderSession.bind(target),
    getAdmittedMcpForwardRoute: target.getAdmittedMcpForwardRoute.bind(target),
    getDiscoveryForwardRoute: target.getDiscoveryForwardRoute.bind(target),
    getNavigationGraphForwardRoute: target.getNavigationGraphForwardRoute.bind(target),
    getResourceReadForwardRoute: target.getResourceReadForwardRoute.bind(target),
    beginMcpSessionOwnerCall: target.beginMcpSessionOwnerCall.bind(target),
    getToolsCallForwardRoute: target.getToolsCallForwardRoute.bind(target),
    getAdmittedToolsCallForwardRoute: target.getAdmittedToolsCallForwardRoute.bind(target),
    hostInventoryOrBoundRoute: target.hostInventoryOrBoundRoute.bind(target),
    isUnboundDeviceAcquisitionTool: target.isUnboundDeviceAcquisitionTool.bind(target),
    profileReaffirmForwardRoute: target.profileReaffirmForwardRoute.bind(target),
    getAcquiredDeviceSessionUuid: target.getAcquiredDeviceSessionUuid.bind(target),
    selectorMcpForwardRoute: target.selectorMcpForwardRoute.bind(target),
    hasImplicitDeviceSelector: target.hasImplicitDeviceSelector.bind(target),
    sharedMcpForwardRoute: target.sharedMcpForwardRoute.bind(target),
    acquisitionMcpForwardRoute: target.acquisitionMcpForwardRoute.bind(target),
    sessionMcpClientKey: target.sessionMcpClientKey.bind(target),
    toolSelectionProfileMcpClientKey: target.toolSelectionProfileMcpClientKey.bind(target),
    sessionScopedForwardRoute: target.sessionScopedForwardRoute.bind(target),
    toolSelectionProfileScopedForwardRoute:
      target.toolSelectionProfileScopedForwardRoute.bind(target),
  };
}

function bindMcpBindings(target: McpBindings): Pick<McpBindings, keyof McpBindings> {
  return {
    restoreSelectorSessions: target.restoreSelectorSessions.bind(target),
    failIfCallTargetsRefusedRestore: target.failIfCallTargetsRefusedRestore.bind(target),
    ownedSessionsOwnerToken: target.ownedSessionsOwnerToken.bind(target),
    selectorSessionIds: target.selectorSessionIds.bind(target),
    releaseBindingsIfSocketDisconnected: target.releaseBindingsIfSocketDisconnected.bind(target),
    releaseDevicePoolMcpSessionBindings: target.releaseDevicePoolMcpSessionBindings.bind(target),
    clearConnectionDevicePin: target.clearConnectionDevicePin.bind(target),
    recordBoundMcpClientKey: target.recordBoundMcpClientKey.bind(target),
    isSessionOwnedByOtherConnection: target.isSessionOwnedByOtherConnection.bind(target),
    honoursBoundSessionMarker: target.honoursBoundSessionMarker.bind(target),
    isRetryableSessionRecoveryResult: target.isRetryableSessionRecoveryResult.bind(target),
    recordSessionBoundMcpClientKey: target.recordSessionBoundMcpClientKey.bind(target),
    targetsOneCallOnly: target.targetsOneCallOnly.bind(target),
    recordGeneratedToolSelectionProfile: target.recordGeneratedToolSelectionProfile.bind(target),
    getBoundMcpClientRoute: target.getBoundMcpClientRoute.bind(target),
    getToolSelectionProfileUuid: target.getToolSelectionProfileUuid.bind(target),
    getGeneratedToolSelectionProfileUuid: target.getGeneratedToolSelectionProfileUuid.bind(target),
    clearBoundMcpClientKey: target.clearBoundMcpClientKey.bind(target),
    clearBoundMcpClientsForReleasedSession:
      target.clearBoundMcpClientsForReleasedSession.bind(target),
    isMcpClientKeyBound: target.isMcpClientKeyBound.bind(target),
    getSessionForDevice: target.getSessionForDevice.bind(target),
    getSessionIncarnation: target.getSessionIncarnation.bind(target),
    hasActiveDaemonSession: target.hasActiveDaemonSession.bind(target),
    getSessionUuid: target.getSessionUuid.bind(target),
    isReleasedBoundSession: target.isReleasedBoundSession.bind(target),
    boundSessionAdmissionArgs: target.boundSessionAdmissionArgs.bind(target),
    withAdmittedBoundSession: target.withAdmittedBoundSession.bind(target),
    admitReleasedBoundSession: target.admitReleasedBoundSession.bind(target),
    expiredBoundSessionRelease: target.expiredBoundSessionRelease.bind(target),
    getRequestArgumentScopeKey: target.getRequestArgumentScopeKey.bind(target),
    getObjectRequestArgumentScopeKey: target.getObjectRequestArgumentScopeKey.bind(target),
    sessionToScopeKey: target.sessionToScopeKey.bind(target),
    getImplicitAutolockScopeKey: target.getImplicitAutolockScopeKey.bind(target),
    resolveImplicitAutolockSession: target.resolveImplicitAutolockSession.bind(target),
    getRequestPlatform: target.getRequestPlatform.bind(target),
    resolveDeviceLabelSession: target.resolveDeviceLabelSession.bind(target),
    getAssignedDeviceForSession: target.getAssignedDeviceForSession.bind(target),
  };
}

function bindSocketIdeRoutes(
  target: SocketIdeRoutes,
): Pick<SocketIdeRoutes, keyof SocketIdeRoutes> {
  return {
    runLocalSocketRequest: target.runLocalSocketRequest.bind(target),
    handleLocalSocketRequest: target.handleLocalSocketRequest.bind(target),
    dispatchInputRoute: target.dispatchInputRoute.bind(target),
    dispatchIdeSocketRequest: target.dispatchIdeSocketRequest.bind(target),
    handleIdeSocketRequest: target.handleIdeSocketRequest.bind(target),
    runTrackedIdeMutation: target.runTrackedIdeMutation.bind(target),
    listBootedDevicesForIdeAction: target.listBootedDevicesForIdeAction.bind(target),
    resolveIdeActionDevices: target.resolveIdeActionDevices.bind(target),
    canonicalFrameDiscovery: target.canonicalFrameDiscovery.bind(target),
    assertFrameTargetProven: target.assertFrameTargetProven.bind(target),
    canonicalFrameDeviceId: target.canonicalFrameDeviceId.bind(target),
    runIdeKeyValueMutation: target.runIdeKeyValueMutation.bind(target),
    assertSocketToolEnabled: target.assertSocketToolEnabled.bind(target),
    requireCurrentFrameContext: target.requireCurrentFrameContext.bind(target),
    inputRequester: target.inputRequester.bind(target),
    resolveInputTargetDevice: target.resolveInputTargetDevice.bind(target),
    assertBrokerConnectionInputTarget: target.assertBrokerConnectionInputTarget.bind(target),
    assertBrokerConnectionControl: target.assertBrokerConnectionControl.bind(target),
    assertBrokerConnectionHostMutation: target.assertBrokerConnectionHostMutation.bind(target),
    captureInputTargetOwner: target.captureInputTargetOwner.bind(target),
    selectInputTargetDevice: target.selectInputTargetDevice.bind(target),
    runTrackedKeyedDeviceInput: target.runTrackedKeyedDeviceInput.bind(target),
    inputDeviceGate: target.inputDeviceGate.bind(target),
    runHeldInputOperation: target.runHeldInputOperation.bind(target),
    dispatchFencedInput: target.dispatchFencedInput.bind(target),
    reconcileDiscoveryObservation: target.reconcileDiscoveryObservation.bind(target),
    assertDeviceActionable: target.assertDeviceActionable.bind(target),
    assertInputBindingGate: target.assertInputBindingGate.bind(target),
    runTrackedDeviceInput: target.runTrackedDeviceInput.bind(target),
    admitInputAsControlCall: target.admitInputAsControlCall.bind(target),
    answeringSessionRelease: target.answeringSessionRelease.bind(target),
    runFencedInputOperation: target.runFencedInputOperation.bind(target),
    discoverInputTargetDevices: target.discoverInputTargetDevices.bind(target),
    mcpRequestOptions: target.mcpRequestOptions.bind(target),
    combineMcpRequestSignals: target.combineMcpRequestSignals.bind(target),
  };
}

function bindSocketInput(target: SocketInput): Pick<SocketInput, keyof SocketInput> {
  return {
    remainingBudgetAfterProbe: target.remainingBudgetAfterProbe.bind(target),
    toIosRunnerCoordinates: target.toIosRunnerCoordinates.bind(target),
    requireCoordinatesWithinKnownScreenGeometry:
      target.requireCoordinatesWithinKnownScreenGeometry.bind(target),
    inputRouteClock: target.inputRouteClock.bind(target),
    remainingInputBudgetMs: target.remainingInputBudgetMs.bind(target),
    runInputRoute: target.runInputRoute.bind(target),
    handleInputTap: target.handleInputTap.bind(target),
    handleInputSwipe: target.handleInputSwipe.bind(target),
    handleInputGesture: target.handleInputGesture.bind(target),
    trackAckedGestureFrame: target.trackAckedGestureFrame.bind(target),
    liftingStrokeOnSessionRefusal: target.liftingStrokeOnSessionRefusal.bind(target),
    captureStrokeAdmission: target.captureStrokeAdmission.bind(target),
    strokeAdmissionStillHolds: target.strokeAdmissionStillHolds.bind(target),
    forwardGestureStart: target.forwardGestureStart.bind(target),
    liftSessionlessStrokesOn: target.liftSessionlessStrokesOn.bind(target),
    liftStrokesHeldByOn: target.liftStrokesHeldByOn.bind(target),
    liftStrokesHeldBy: target.liftStrokesHeldBy.bind(target),
    cancelGestureOnDevice: target.cancelGestureOnDevice.bind(target),
    forwardGestureFrame: target.forwardGestureFrame.bind(target),
    handleInputPressButton: target.handleInputPressButton.bind(target),
    handleInputKey: target.handleInputKey.bind(target),
    executeSocketInputKey: target.executeSocketInputKey.bind(target),
  };
}

function bindSocketTextInput(
  target: SocketTextInput,
): Pick<SocketTextInput, keyof SocketTextInput> {
  return {
    handleInputTypeText: target.handleInputTypeText.bind(target),
    indeterminateTextError: target.indeterminateTextError.bind(target),
    holdDispatchedInputRequest: target.holdDispatchedInputRequest.bind(target),
    createSocketInputAdbFactory: target.createSocketInputAdbFactory.bind(target),
    createSocketAppendTextInput: target.createSocketAppendTextInput.bind(target),
    executeInputTypeText: target.executeInputTypeText.bind(target),
    executeAndroidAppendText: target.executeAndroidAppendText.bind(target),
    retryAppendTextWithRebuiltHelper: target.retryAppendTextWithRebuiltHelper.bind(target),
    validateAppendFrameContext: target.validateAppendFrameContext.bind(target),
    runImeActionWithinBudget: target.runImeActionWithinBudget.bind(target),
    runInputOperationWithTimeout: target.runInputOperationWithTimeout.bind(target),
    parseInputTapParams: target.parseInputTapParams.bind(target),
    parseInputSwipeParams: target.parseInputSwipeParams.bind(target),
    parseInputTypeTextParams: target.parseInputTypeTextParams.bind(target),
    parseInputPressButtonParams: target.parseInputPressButtonParams.bind(target),
    parseInputKeyParams: target.parseInputKeyParams.bind(target),
    parseInputGestureParams: target.parseInputGestureParams.bind(target),
    evictDeviceInputCache: target.evictDeviceInputCache.bind(target),
    getAppendTextInput: target.getAppendTextInput.bind(target),
  };
}

/**
 * Facade delegates call the defaults; collaborators call the overridable callback table.
 * Resolving that table lazily closes cross-collaborator callbacks after construction and keeps
 * subclass overrides and typed test-hook replacements on the real execution path.
 */
export function createSocketServerOperations(
  state: SocketServerRuntime,
  overrides: SocketServerOverrides,
) {
  const socketLifecycle = new SocketLifecycle(state, () => callbacks);
  const socketTransport = new SocketTransport(state, () => callbacks);
  const socketAdmission = new SocketAdmission(state, () => callbacks);
  const mcpExecution = new McpExecution(state, () => callbacks);
  const mcpRouting = new McpRouting(state, () => callbacks);
  const mcpBindings = new McpBindings(state, () => callbacks);
  const socketIdeRoutes = new SocketIdeRoutes(state, () => callbacks);
  const socketInput = new SocketInput(state, () => callbacks);
  const socketTextInput = new SocketTextInput(state, () => callbacks);
  const implementations: SocketServerOperations = {
    ...bindSocketLifecycle(socketLifecycle),
    ...bindSocketTransport(socketTransport),
    ...bindSocketAdmission(socketAdmission),
    ...bindMcpExecution(mcpExecution),
    ...bindMcpRouting(mcpRouting),
    ...bindMcpBindings(mcpBindings),
    ...bindSocketIdeRoutes(socketIdeRoutes),
    ...bindSocketInput(socketInput),
    ...bindSocketTextInput(socketTextInput),
  };
  const callbacks: SocketServerOperations = { ...implementations, ...overrides };
  return { implementations, callbacks };
}
