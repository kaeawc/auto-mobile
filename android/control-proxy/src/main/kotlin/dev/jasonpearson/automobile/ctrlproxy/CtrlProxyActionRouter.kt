package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.protocol.NodeSelector
import dev.jasonpearson.automobile.protocol.PrototypeAppearanceOverride
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.RequestCommitText
import dev.jasonpearson.automobile.protocol.RequestDrag
import dev.jasonpearson.automobile.protocol.RequestGestureEnd
import dev.jasonpearson.automobile.protocol.RequestGestureStart
import dev.jasonpearson.automobile.protocol.RequestGlobalAction
import dev.jasonpearson.automobile.protocol.RequestHierarchy
import dev.jasonpearson.automobile.protocol.RequestImeAction
import dev.jasonpearson.automobile.protocol.RequestInsertText
import dev.jasonpearson.automobile.protocol.RequestPinch
import dev.jasonpearson.automobile.protocol.RequestScreenshot
import dev.jasonpearson.automobile.protocol.RequestSetText
import dev.jasonpearson.automobile.protocol.RequestSwipe
import dev.jasonpearson.automobile.protocol.RequestTapCoordinates
import dev.jasonpearson.automobile.protocol.RequestTwoFingerSwipe
import dev.jasonpearson.automobile.protocol.SetPreference
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.put

/**
 * The inbound WebSocket commands, dispatched by [CtrlProxyMessageHandler]. Each one hands off to
 * the feature controller [service] owns; this class holds no state of its own.
 */
// One handler per CtrlProxyActions method, so the count is the interface's (itself baselined).
@Suppress("TooManyFunctions")
internal class CtrlProxyActionRouter(private val service: CtrlProxy) : CtrlProxyActions {
  private companion object {
    // The service's log tag, so moved handlers keep logging under it.
    const val TAG = "CtrlProxy"
  }

  override suspend fun requestHierarchy(request: RequestHierarchy) =
    service.hierarchyController.requestHierarchy(request)

  override suspend fun requestHierarchyIfStale(sinceTimestamp: Long, requestId: String?) =
    service.hierarchyController.requestHierarchyIfStale(sinceTimestamp, requestId)

  override suspend fun setHierarchyInterval(intervalMs: Long?) =
    service.hierarchyController.setHierarchyInterval(intervalMs)

  override suspend fun requestScreenshot(request: RequestScreenshot) {
    val requestId = request.requestId
    val displayId = request.displayId
    val hidePrototypes = request.hidePrototypes

    service.screenshotRequests.broadcastScreenshot(requestId, displayId, hidePrototypes)
  }

  override suspend fun requestDoubleTapCoordinates(
    requestId: String?,
    x: Double,
    y: Double,
    frameContext: String?,
    displayId: Int?,
  ) {
    if (
      service.staleFrames.rejectStaleFrameContext(
        requestId,
        frameContext,
        StaleFrameContextAction.TAP,
      )
    )
      return
    service.gestureController.performTapCoordinates(
      RequestTapCoordinates(
        requestId = requestId,
        x = x,
        y = y,
        duration = 50L,
        frameContext = frameContext,
        displayId = displayId,
        doubleTap = true,
      ),
    )
  }

  override suspend fun requestTapCoordinates(request: RequestTapCoordinates) {
    val requestId = request.requestId
    val frameContext = request.frameContext
    if (
      service.staleFrames.rejectStaleFrameContext(
        requestId,
        frameContext,
        StaleFrameContextAction.TAP,
      )
    )
      return
    // A plain tap request is never a double tap; that arrives as its own request.
    service.gestureController.performTapCoordinates(request.copy(doubleTap = false))
  }

  override suspend fun requestSwipe(request: RequestSwipe) {
    val requestId = request.requestId
    val frameContext = request.frameContext
    if (
      service.staleFrames.rejectStaleFrameContext(
        requestId,
        frameContext,
        StaleFrameContextAction.SWIPE,
      )
    )
      return
    service.gestureController.performSwipe(request)
  }

  override suspend fun requestTwoFingerSwipe(request: RequestTwoFingerSwipe) =
    service.gestureController.performTwoFingerSwipe(request)

  override suspend fun requestDrag(request: RequestDrag) {
    val requestId = request.requestId
    val frameContext = request.frameContext
    if (
      service.staleFrames.rejectStaleFrameContext(
        requestId,
        frameContext,
        StaleFrameContextAction.DRAG,
      )
    )
      return
    // The drag reads the resolved durations, so the legacy holdTime/duration fields need no copy.
    service.gestureController.performDrag(request)
  }

  override suspend fun requestPinch(request: RequestPinch) =
    service.gestureController.performPinch(request)

  override suspend fun requestGestureStart(request: RequestGestureStart) =
    service.gestureController.startStream(request, requester = CommandOriginContext.currentClient())

  override suspend fun requestGestureMove(
    requestId: String?,
    gestureId: String,
    x: Double,
    y: Double,
  ) {
    service.gestureController.moveStream(requestId, gestureId, x, y)
  }

  override suspend fun requestGestureEnd(
    requestId: String?,
    gestureId: String,
    x: Double,
    y: Double,
    cancel: Boolean,
  ) {
    service.gestureController.endStream(
      RequestGestureEnd(
        requestId = requestId,
        gestureId = gestureId,
        x = x,
        y = y,
        cancel = cancel,
      ),
      requester = CommandOriginContext.currentClient(),
    )
  }

  override suspend fun requestSetText(request: RequestSetText) {
    val requestId = request.requestId
    val text = request.text
    val resourceId = request.resourceId
    val dismissKeyboard = request.dismissKeyboard
    val frameContext = request.frameContext

    if (
      service.staleFrames.rejectStaleFrameContext(
        requestId,
        frameContext,
        StaleFrameContextAction.SET_TEXT,
      )
    )
      return
    service.textInputController.performSetText(requestId, text, resourceId, dismissKeyboard)
  }

  override suspend fun requestInsertTextState(requestId: String?) =
    service.textInputController.handleInsertTextState(requestId)

  override suspend fun requestInsertText(request: RequestInsertText) {
    val requestId = request.requestId
    val text = request.text
    val expectedSuffix = request.expectedSuffix
    val acceptsCaretNotPlaced = request.acceptsCaretNotPlaced
    val precedingState = request.precedingState

    service.textInputController.performInsertText(
      requestId,
      text,
      expectedSuffix,
      acceptsCaretNotPlaced,
      precedingState,
    )
  }

  override suspend fun requestCommitText(request: RequestCommitText) =
    service.imeController.requestCommitText(request)

  override suspend fun requestCancelImeCommit(requestId: String?, targetRequestId: String) =
    service.imeController.requestCancelImeCommit(requestId, targetRequestId)

  override suspend fun requestSetKeyboardProfile(requestId: String?, profileId: String) =
    service.imeController.requestSetKeyboardProfile(requestId, profileId)

  override suspend fun requestListKeyboardProfiles(
    requestId: String?,
    supportedCatalogVersions: List<Int>,
  ) = service.imeController.requestListKeyboardProfiles(requestId, supportedCatalogVersions)

  override suspend fun requestImeAction(request: RequestImeAction) {
    val requestId = request.requestId
    val action = request.action
    val frameContext = request.frameContext

    if (
      service.staleFrames.rejectStaleFrameContext(
        requestId,
        frameContext,
        StaleFrameContextAction.IME_ACTION,
      )
    )
      return
    service.textInputController.performImeAction(requestId, action)
  }

  override suspend fun requestSelectAll(requestId: String?) =
    service.textInputController.performSelectAll(requestId)

  override suspend fun requestClickFocusedInput(requestId: String?) =
    service.nodeActionController.clickFocusedInputRequest(requestId)

  override suspend fun requestAction(
    requestId: String?,
    action: String,
    resourceId: String?,
    selector: NodeSelector?,
    arguments: NodeActionArguments,
  ) =
    service.nodeActionController.performNodeAction(
      requestId,
      action,
      resourceId,
      selector,
      arguments,
    )

  override suspend fun requestActivateAccessibilityLink(
    requestId: String?,
    text: String,
    occurrence: Int,
    selector: NodeSelector?,
  ) =
    service.nodeActionController.performAccessibilityLinkActivation(
      requestId,
      text,
      occurrence,
      selector,
    )

  override suspend fun requestClipboard(requestId: String?, action: String, text: String?) =
    service.clipboardController.performClipboard(requestId, action, text)

  override suspend fun installCaCert(requestId: String?, certificate: String) =
    service.caCertificateController.performInstallCaCertificate(requestId, certificate)

  override suspend fun installCaCertFromPath(requestId: String?, devicePath: String) =
    service.caCertificateController.performInstallCaCertificateFromPath(requestId, devicePath)

  override suspend fun removeCaCert(requestId: String?, alias: String?, certificate: String?) =
    service.caCertificateController.performRemoveCaCertificate(requestId, alias, certificate)

  override suspend fun requestGlobalAction(request: RequestGlobalAction) {
    val requestId = request.requestId
    val action = request.action
    val frameContext = request.frameContext

    if (
      service.staleFrames.rejectStaleFrameContext(
        requestId,
        frameContext,
        StaleFrameContextAction.GLOBAL_ACTION,
      )
    )
      return
    service.globalActionController.performGlobalActionRequest(requestId, action)
  }

  override suspend fun validateFrameContext(requestId: String?, frameContext: String) =
    service.frameContextGate.validate(requestId, frameContext)

  override suspend fun requestDeviceInfo(requestId: String?) =
    service.deviceInfoController.performDeviceInfoRequest(requestId)

  override suspend fun getDeviceOwnerStatus(requestId: String?) =
    service.caCertificateController.performGetDeviceOwnerStatus(requestId)

  override suspend fun getPermission(
    requestId: String?,
    permission: String?,
    requestPermission: Boolean?,
  ) = service.permissionController.getPermission(requestId, permission, requestPermission)

  override suspend fun setRecompositionTracking(enabled: Boolean) =
    service.sdkControlController.setRecompositionTrackingEnabled(enabled)

  override suspend fun setAccessibilityFlags(
    includeNotImportantViews: Boolean,
    reportViewIds: Boolean,
    retrieveInteractiveWindows: Boolean,
    occlusionEnabled: Boolean,
  ) {
    service.accessibilityFlags.apply(
      includeNotImportantViews = includeNotImportantViews,
      reportViewIds = reportViewIds,
      retrieveInteractiveWindows = retrieveInteractiveWindows,
      occlusionEnabled = occlusionEnabled,
    )
  }

  override suspend fun setNetworkMockRules(requestId: String?, rulesJson: String) =
    service.sdkControlController.broadcastNetworkMockRules(requestId, rulesJson)

  override suspend fun setNetworkErrorSimulation(
    enabled: Boolean,
    errorType: String?,
    limit: Int?,
    expiresAtEpochMs: Long?,
    remainingMs: Long?,
  ) =
    service.sdkControlController.broadcastNetworkErrorSimulation(
      enabled,
      errorType,
      limit,
      expiresAtEpochMs,
      remainingMs,
    )

  override suspend fun getCurrentFocus(requestId: String?) =
    service.focusController.handleGetCurrentFocus(requestId)

  override suspend fun getTraversalOrder(requestId: String?) =
    service.focusController.handleGetTraversalOrder(requestId)

  override suspend fun addHighlight(
    requestId: String?,
    highlightId: String?,
    shape: HighlightShape?,
  ) = service.focusController.handleAddHighlight(requestId, highlightId, shape)

  override suspend fun showPrototype(
    requestId: String?,
    spec: PrototypeSpec,
    displayId: Int?,
    reset: Boolean,
    appearance: PrototypeAppearanceOverride?,
    replaceOthers: Boolean,
    locale: String?,
  ) {
    service.launchRequestScope(requestId) {
      service.prototypeController.show(
        requestId,
        spec,
        displayId,
        reset,
        appearance,
        replaceOthers,
        locale,
      )
    }
  }

  override suspend fun dismissPrototype(requestId: String?, id: String?, all: Boolean?) {
    service.launchRequestScope(requestId) {
      service.prototypeController.dismiss(requestId, id, all)
    }
  }

  override suspend fun savePrototype(
    requestId: String?,
    spec: PrototypeSpec,
    label: String,
    icon: String?,
  ) {
    service.launchRequestScope(requestId) {
      service.savedPrototypeController.save(requestId, spec, label, icon)
    }
  }

  override suspend fun pinSavedPrototype(requestId: String?, id: String, icon: String?) {
    service.launchRequestScope(requestId) {
      service.savedPrototypeController.pin(requestId, id, icon)
    }
  }

  override suspend fun listSavedPrototypes(requestId: String?) {
    service.launchRequestScope(requestId) { service.savedPrototypeController.list(requestId) }
  }

  override suspend fun deleteSavedPrototype(requestId: String?, id: String) {
    service.launchRequestScope(requestId) { service.savedPrototypeController.delete(requestId, id) }
  }

  override suspend fun advancePrototypeClock(requestId: String?, id: String, advanceTimeMs: Int) {
    service.launchRequestScope(requestId) {
      service.prototypeController.advanceClock(requestId, id, advanceTimeMs)
    }
  }

  override suspend fun clearPrototypeStorage(requestId: String?, id: String) {
    service.launchRequestScope(requestId) {
      service.prototypeController.clearStorage(requestId, id)
    }
  }

  override suspend fun patchPrototype(
    requestId: String?,
    id: String,
    baseRevision: Long?,
    ops: JsonArray,
  ) {
    service.launchRequestScope(requestId) {
      service.prototypeController.patch(requestId, id, baseRevision, ops)
    }
  }

  override suspend fun inspectPrototypes(requestId: String?) {
    service.launchRequestScope(requestId) { service.prototypeController.inspect(requestId) }
  }

  override suspend fun putPrototypeAsset(
    requestId: String?,
    id: String,
    mimeType: String,
    dataBase64: String,
  ) {
    service.launchRequestScope(requestId) {
      service.prototypeAssetController.put(requestId, id, mimeType, dataBase64)
    }
  }

  override suspend fun removePrototypeAsset(requestId: String?, id: String) {
    service.launchRequestScope(requestId) { service.prototypeAssetController.remove(requestId, id) }
  }

  override suspend fun listPreferenceFiles(requestId: String?, packageName: String) =
    service.storageController.handleListPreferenceFiles(requestId, packageName)

  override suspend fun getPreferences(requestId: String?, packageName: String, fileName: String) =
    service.storageController.handleGetPreferences(requestId, packageName, fileName)

  override suspend fun resetKeystore(
    requestId: String?,
    packageName: String,
    scope: String?,
    alias: String?,
  ) = service.appDiscovery.resetKeystore(requestId, packageName, scope, alias)

  override suspend fun discoverKeystore(requestId: String?, packageName: String) =
    service.appDiscovery.discoverKeystore(requestId, packageName)

  override suspend fun getSdkCapabilities(requestId: String?, packageName: String, userId: Int?) =
    service.appDiscovery.discoverSdkCapabilities(requestId, packageName, userId)

  override suspend fun listDataStores(
    requestId: String?,
    packageName: String,
    adapterName: String,
  ) = service.storageController.handleListDataStores(requestId, packageName, adapterName)

  override suspend fun getDataStore(
    requestId: String?,
    packageName: String,
    adapterName: String,
    storeName: String,
  ) = service.storageController.handleGetDataStore(requestId, packageName, adapterName, storeName)

  override suspend fun subscribeStorage(requestId: String?, packageName: String, fileName: String) =
    service.storageController.handleSubscribeStorage(requestId, packageName, fileName)

  override suspend fun unsubscribeStorage(
    requestId: String?,
    packageName: String,
    fileName: String,
  ) = service.storageController.handleUnsubscribeStorage(requestId, packageName, fileName)

  override suspend fun getPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) = service.storageController.handleGetPreference(requestId, packageName, fileName, key)

  override suspend fun setPreference(request: SetPreference) =
    service.storageController.handleSetPreference(request)

  override suspend fun removePreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) = service.storageController.handleRemovePreference(requestId, packageName, fileName, key)

  override suspend fun clearPreferences(requestId: String?, packageName: String, fileName: String) =
    service.storageController.handleClearPreferences(requestId, packageName, fileName)

  override suspend fun startRecording() {
    // Accepted for wire compatibility; currently has no effect on the device.
    Log.d(TAG, "Recording started")
  }

  override suspend fun stopRecording() {
    // Accepted for wire compatibility; currently has no effect on the device.
    Log.d(TAG, "Recording stopped")
  }

  override suspend fun requestSettingsGet(requestId: String?, namespace: String, key: String) =
    service.settingsController.performSettingsRead(requestId, namespace, key)

  override suspend fun requestSettingsPut(
    requestId: String?,
    namespace: String,
    key: String,
    value: String?,
    valueType: String,
  ) = service.settingsController.performSettingsWrite(requestId, namespace, key, value, valueType)

  override suspend fun requestSettingsList(requestId: String?, namespace: String) =
    service.settingsController.performSettingsList(requestId, namespace)

  override suspend fun requestInstalledPackages(
    requestId: String?,
    includeSystem: Boolean,
    userId: Int?,
  ) = service.packageController.performInstalledPackages(requestId, includeSystem, userId)

  override suspend fun requestPackageInfo(
    requestId: String?,
    packageName: String,
    includePermissions: Boolean,
  ) = service.packageController.performPackageInfo(requestId, packageName, includePermissions)

  override suspend fun requestLaunchIntent(requestId: String?, packageName: String) =
    service.packageController.performLaunchIntent(requestId, packageName)
}
