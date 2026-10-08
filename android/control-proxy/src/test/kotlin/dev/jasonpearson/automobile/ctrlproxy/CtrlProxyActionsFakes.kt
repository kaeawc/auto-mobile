package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.protocol.OverlayScalar
import dev.jasonpearson.automobile.protocol.OverlaySpec

/**
 * No-op [CtrlProxyActions] base for tests that only care about a couple of actions — subclass and
 * override just those. Keeps partial test doubles concise now that the interface is non-optional.
 */
open class NoOpCtrlProxyActions : CtrlProxyActions {
  override suspend fun requestHierarchy(disableAllFiltering: Boolean, requestId: String?) {}

  override fun requestHierarchyIfStale(sinceTimestamp: Long, requestId: String?) {}

  override fun setHierarchyInterval(intervalMs: Long?) {}

  override fun requestScreenshot(requestId: String?) {}

  override fun requestSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
  ) {}

  override fun requestTapCoordinates(requestId: String?, x: Double, y: Double, duration: Long) {}

  override fun requestTwoFingerSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
    offset: Int,
  ) {}

  override fun requestDrag(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    pressDurationMs: Long,
    dragDurationMs: Long,
    holdDurationMs: Long,
  ) {}

  override fun requestPinch(
    requestId: String?,
    centerX: Double,
    centerY: Double,
    distanceStart: Double,
    distanceEnd: Double,
    rotationDegrees: Float,
    duration: Long,
  ) {}

  override fun requestGestureStart(requestId: String?, gestureId: String, x: Double, y: Double) {}

  override fun requestGestureMove(requestId: String?, gestureId: String, x: Double, y: Double) {}

  override fun requestGestureEnd(
    requestId: String?,
    gestureId: String,
    x: Double,
    y: Double,
    cancel: Boolean,
  ) {}

  override suspend fun requestSetText(
    requestId: String?,
    text: String,
    resourceId: String?,
    dismissKeyboard: Boolean,
  ) {}

  override fun requestInsertText(requestId: String?, text: String) {}

  override fun requestCommitText(requestId: String?, text: String, priorImeId: String?) {}

  override fun requestSetKeyboardProfile(requestId: String?, profileId: String) {}

  override fun requestListKeyboardProfiles(
    requestId: String?,
    supportedCatalogVersions: List<Int>,
  ) {}

  override fun requestImeAction(requestId: String?, action: String) {}

  override fun requestSelectAll(requestId: String?) {}

  override fun requestClickFocusedInput(requestId: String?) {}

  override fun requestAction(
    requestId: String?,
    action: String,
    resourceId: String?,
    selector: dev.jasonpearson.automobile.protocol.NodeSelector?,
  ) {}

  override fun requestActivateAccessibilityLink(
    requestId: String?,
    text: String,
    occurrence: Int,
    selector: dev.jasonpearson.automobile.protocol.NodeSelector?,
  ) {}

  override fun requestClipboard(requestId: String?, action: String, text: String?) {}

  override fun installCaCert(requestId: String?, certificate: String) {}

  override fun installCaCertFromPath(requestId: String?, devicePath: String) {}

  override fun removeCaCert(requestId: String?, alias: String?, certificate: String?) {}

  override fun requestGlobalAction(requestId: String?, action: String) {}

  override fun requestDeviceInfo(requestId: String?) {}

  override fun getDeviceOwnerStatus(requestId: String?) {}

  override fun getPermission(
    requestId: String?,
    permission: String?,
    requestPermission: Boolean?,
  ) {}

  override fun setRecompositionTracking(enabled: Boolean) {}

  override fun setAccessibilityFlags(
    includeNotImportantViews: Boolean,
    reportViewIds: Boolean,
    retrieveInteractiveWindows: Boolean,
    occlusionEnabled: Boolean,
  ) {}

  override fun setNetworkMockRules(requestId: String?, rulesJson: String) {}

  override fun setNetworkErrorSimulation(
    enabled: Boolean,
    errorType: String?,
    limit: Int?,
    expiresAtEpochMs: Long?,
    remainingMs: Long?,
  ) {}

  override fun getCurrentFocus(requestId: String?) {}

  override fun getTraversalOrder(requestId: String?) {}

  override fun addHighlight(requestId: String?, highlightId: String?, shape: HighlightShape?) {}

  override fun showOverlay(requestId: String?, spec: OverlaySpec, displayId: Int?) {}

  override fun updateOverlay(
    requestId: String?,
    id: String,
    spec: OverlaySpec?,
    state: Map<String, OverlayScalar>?,
  ) {}

  override fun dismissOverlay(requestId: String?, id: String?, all: Boolean?) {}

  override fun putOverlayAsset(
    requestId: String?,
    id: String,
    mimeType: String,
    dataBase64: String,
  ) {}

  override fun removeOverlayAsset(requestId: String?, id: String) {}

  override fun listPreferenceFiles(requestId: String?, packageName: String) {}

  override fun getPreferences(requestId: String?, packageName: String, fileName: String) {}

  override fun discoverKeystore(requestId: String?, packageName: String) {}

  override fun getSdkCapabilities(requestId: String?, packageName: String, userId: Int?) {}

  override fun listDataStores(requestId: String?, packageName: String, adapterName: String) {}

  override fun getDataStore(
    requestId: String?,
    packageName: String,
    adapterName: String,
    storeName: String,
  ) {}

  override fun subscribeStorage(requestId: String?, packageName: String, fileName: String) {}

  override fun unsubscribeStorage(requestId: String?, packageName: String, fileName: String) {}

  override fun getPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) {}

  override fun setPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
    value: String?,
    type: String,
  ) {}

  override fun removePreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) {}

  override fun clearPreferences(requestId: String?, packageName: String, fileName: String) {}

  override fun startRecording() {}

  override fun stopRecording() {}

  override fun requestSettingsGet(requestId: String?, namespace: String, key: String) {}

  override fun requestSettingsPut(
    requestId: String?,
    namespace: String,
    key: String,
    value: String?,
    valueType: String,
  ) {}

  override fun requestSettingsList(requestId: String?, namespace: String) {}

  override fun requestInstalledPackages(requestId: String?, includeSystem: Boolean, userId: Int?) {}

  override fun requestPackageInfo(
    requestId: String?,
    packageName: String,
    includePermissions: Boolean,
  ) {}

  override fun requestLaunchIntent(requestId: String?, packageName: String) {}
}

/**
 * Recording [CtrlProxyActions] fake: every call is appended to [calls] as `(methodName, args)`, so
 * a dispatch test can assert both which action fired and the exact arguments it received.
 */
class RecordingCtrlProxyActions : CtrlProxyActions {
  val calls = mutableListOf<Pair<String, List<Any?>>>()

  private fun record(name: String, vararg args: Any?) {
    calls.add(name to args.toList())
  }

  override suspend fun requestHierarchy(disableAllFiltering: Boolean, requestId: String?) =
    record("requestHierarchy", disableAllFiltering, requestId)

  override fun requestHierarchyIfStale(sinceTimestamp: Long, requestId: String?) =
    record("requestHierarchyIfStale", sinceTimestamp, requestId)

  override fun setHierarchyInterval(intervalMs: Long?) = record("setHierarchyInterval", intervalMs)

  override fun requestScreenshot(requestId: String?) = record("requestScreenshot", requestId)

  override fun requestSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
  ) = record("requestSwipe", requestId, x1, y1, x2, y2, duration)

  override fun requestDoubleTapCoordinates(
    requestId: String?,
    x: Double,
    y: Double,
    frameContext: String?,
    displayId: Int?,
  ) = record("requestDoubleTapCoordinates", requestId, x, y, frameContext, displayId)

  override fun requestTapCoordinates(requestId: String?, x: Double, y: Double, duration: Long) =
    record("requestTapCoordinates", requestId, x, y, duration)

  override fun requestTwoFingerSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
    offset: Int,
  ) = record("requestTwoFingerSwipe", requestId, x1, y1, x2, y2, duration, offset)

  override fun requestDrag(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    pressDurationMs: Long,
    dragDurationMs: Long,
    holdDurationMs: Long,
  ) =
    record(
      "requestDrag",
      requestId,
      x1,
      y1,
      x2,
      y2,
      pressDurationMs,
      dragDurationMs,
      holdDurationMs,
    )

  override fun requestPinch(
    requestId: String?,
    centerX: Double,
    centerY: Double,
    distanceStart: Double,
    distanceEnd: Double,
    rotationDegrees: Float,
    duration: Long,
  ) =
    record(
      "requestPinch",
      requestId,
      centerX,
      centerY,
      distanceStart,
      distanceEnd,
      rotationDegrees,
      duration,
    )

  override fun requestGestureStart(requestId: String?, gestureId: String, x: Double, y: Double) =
    record("requestGestureStart", requestId, gestureId, x, y)

  override fun requestGestureMove(requestId: String?, gestureId: String, x: Double, y: Double) =
    record("requestGestureMove", requestId, gestureId, x, y)

  override fun requestGestureEnd(
    requestId: String?,
    gestureId: String,
    x: Double,
    y: Double,
    cancel: Boolean,
  ) = record("requestGestureEnd", requestId, gestureId, x, y, cancel)

  override suspend fun requestSetText(
    requestId: String?,
    text: String,
    resourceId: String?,
    dismissKeyboard: Boolean,
  ) = record("requestSetText", requestId, text, resourceId, dismissKeyboard)

  override suspend fun requestSetText(
    requestId: String?,
    text: String,
    resourceId: String?,
    dismissKeyboard: Boolean,
    frameContext: String?,
  ) = record("requestSetText", requestId, text, resourceId, dismissKeyboard, frameContext)

  override fun requestInsertTextState(requestId: String?) =
    record("requestInsertTextState", requestId)

  override fun requestInsertText(
    requestId: String?,
    text: String,
    expectedSuffix: String?,
    acceptsCaretNotPlaced: Boolean,
    precedingState: dev.jasonpearson.automobile.protocol.InsertTextState?,
  ) =
    record(
      "requestInsertText",
      requestId,
      text,
      expectedSuffix,
      acceptsCaretNotPlaced,
      precedingState,
    )

  override fun requestInsertText(requestId: String?, text: String) =
    record("requestInsertText", requestId, text)

  override fun requestInsertText(requestId: String?, text: String, expectedSuffix: String?) =
    record("requestInsertText", requestId, text, expectedSuffix)

  override fun requestInsertText(
    requestId: String?,
    text: String,
    expectedSuffix: String?,
    acceptsCaretNotPlaced: Boolean,
  ) = record("requestInsertText", requestId, text, expectedSuffix, acceptsCaretNotPlaced)

  override fun requestCommitText(requestId: String?, text: String, priorImeId: String?) =
    record("requestCommitText", requestId, text, priorImeId)

  override fun requestCommitText(
    requestId: String?,
    text: String,
    priorImeId: String?,
    delivery: dev.jasonpearson.automobile.protocol.ImeTextDelivery,
    timeoutMs: Long?,
  ) = record("requestCommitText", requestId, text, priorImeId, delivery, timeoutMs)

  override fun requestCancelImeCommit(requestId: String?, targetRequestId: String) =
    record("requestCancelImeCommit", requestId, targetRequestId)

  override fun requestSetKeyboardProfile(requestId: String?, profileId: String) =
    record("requestSetKeyboardProfile", requestId, profileId)

  override fun requestListKeyboardProfiles(
    requestId: String?,
    supportedCatalogVersions: List<Int>,
  ) = record("requestListKeyboardProfiles", requestId, supportedCatalogVersions)

  override fun requestImeAction(requestId: String?, action: String) =
    record("requestImeAction", requestId, action)

  override fun requestImeAction(requestId: String?, action: String, frameContext: String?) =
    record("requestImeAction", requestId, action, frameContext)

  override fun requestSelectAll(requestId: String?) = record("requestSelectAll", requestId)

  override fun requestClickFocusedInput(requestId: String?) =
    record("requestClickFocusedInput", requestId)

  override fun requestAction(
    requestId: String?,
    action: String,
    resourceId: String?,
    selector: dev.jasonpearson.automobile.protocol.NodeSelector?,
  ) = record("requestAction", requestId, action, resourceId, selector)

  override fun requestActivateAccessibilityLink(
    requestId: String?,
    text: String,
    occurrence: Int,
    selector: dev.jasonpearson.automobile.protocol.NodeSelector?,
  ) = record("requestActivateAccessibilityLink", requestId, text, occurrence, selector)

  override fun requestClipboard(requestId: String?, action: String, text: String?) =
    record("requestClipboard", requestId, action, text)

  override fun installCaCert(requestId: String?, certificate: String) =
    record("installCaCert", requestId, certificate)

  override fun installCaCertFromPath(requestId: String?, devicePath: String) =
    record("installCaCertFromPath", requestId, devicePath)

  override fun removeCaCert(requestId: String?, alias: String?, certificate: String?) =
    record("removeCaCert", requestId, alias, certificate)

  override fun requestGlobalAction(requestId: String?, action: String) =
    record("requestGlobalAction", requestId, action)

  override fun requestGlobalAction(requestId: String?, action: String, frameContext: String?) =
    record("requestGlobalAction", requestId, action, frameContext)

  override fun validateFrameContext(requestId: String?, frameContext: String) =
    record("validateFrameContext", requestId, frameContext)

  override fun requestDeviceInfo(requestId: String?) = record("requestDeviceInfo", requestId)

  override fun getDeviceOwnerStatus(requestId: String?) = record("getDeviceOwnerStatus", requestId)

  override fun getPermission(
    requestId: String?,
    permission: String?,
    requestPermission: Boolean?,
  ) = record("getPermission", requestId, permission, requestPermission)

  override fun setRecompositionTracking(enabled: Boolean) =
    record("setRecompositionTracking", enabled)

  override fun setAccessibilityFlags(
    includeNotImportantViews: Boolean,
    reportViewIds: Boolean,
    retrieveInteractiveWindows: Boolean,
    occlusionEnabled: Boolean,
  ) =
    record(
      "setAccessibilityFlags",
      includeNotImportantViews,
      reportViewIds,
      retrieveInteractiveWindows,
      occlusionEnabled,
    )

  override fun setNetworkMockRules(requestId: String?, rulesJson: String) =
    record("setNetworkMockRules", rulesJson, requestId)

  override fun setNetworkErrorSimulation(
    enabled: Boolean,
    errorType: String?,
    limit: Int?,
    expiresAtEpochMs: Long?,
    remainingMs: Long?,
  ) = record("setNetworkErrorSimulation", enabled, errorType, limit, expiresAtEpochMs, remainingMs)

  override fun getCurrentFocus(requestId: String?) = record("getCurrentFocus", requestId)

  override fun getTraversalOrder(requestId: String?) = record("getTraversalOrder", requestId)

  override fun addHighlight(requestId: String?, highlightId: String?, shape: HighlightShape?) =
    record("addHighlight", requestId, highlightId, shape)

  override fun showOverlay(requestId: String?, spec: OverlaySpec, displayId: Int?) =
    record("showOverlay", requestId, spec, displayId)

  override fun updateOverlay(
    requestId: String?,
    id: String,
    spec: OverlaySpec?,
    state: Map<String, OverlayScalar>?,
  ) = record("updateOverlay", requestId, id, spec, state)

  override fun dismissOverlay(requestId: String?, id: String?, all: Boolean?) =
    record("dismissOverlay", requestId, id, all)

  override fun putOverlayAsset(
    requestId: String?,
    id: String,
    mimeType: String,
    dataBase64: String,
  ) = record("putOverlayAsset", requestId, id, mimeType, dataBase64)

  override fun removeOverlayAsset(requestId: String?, id: String) =
    record("removeOverlayAsset", requestId, id)

  override fun listPreferenceFiles(requestId: String?, packageName: String) =
    record("listPreferenceFiles", requestId, packageName)

  override fun getPreferences(requestId: String?, packageName: String, fileName: String) =
    record("getPreferences", requestId, packageName, fileName)

  override fun discoverKeystore(requestId: String?, packageName: String) =
    record("discoverKeystore", requestId, packageName)

  override fun getSdkCapabilities(requestId: String?, packageName: String, userId: Int?) =
    record("getSdkCapabilities", requestId, packageName, userId)

  override fun listDataStores(requestId: String?, packageName: String, adapterName: String) =
    record("listDataStores", requestId, packageName, adapterName)

  override fun getDataStore(
    requestId: String?,
    packageName: String,
    adapterName: String,
    storeName: String,
  ) = record("getDataStore", requestId, packageName, adapterName, storeName)

  override fun subscribeStorage(requestId: String?, packageName: String, fileName: String) =
    record("subscribeStorage", requestId, packageName, fileName)

  override fun unsubscribeStorage(requestId: String?, packageName: String, fileName: String) =
    record("unsubscribeStorage", requestId, packageName, fileName)

  override fun getPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) = record("getPreference", requestId, packageName, fileName, key)

  override fun setPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
    value: String?,
    type: String,
  ) = record("setPreference", requestId, packageName, fileName, key, value, type)

  override fun removePreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) = record("removePreference", requestId, packageName, fileName, key)

  override fun clearPreferences(requestId: String?, packageName: String, fileName: String) =
    record("clearPreferences", requestId, packageName, fileName)

  override fun startRecording() = record("startRecording")

  override fun stopRecording() = record("stopRecording")

  override fun requestSettingsGet(requestId: String?, namespace: String, key: String) =
    record("requestSettingsGet", requestId, namespace, key)

  override fun requestSettingsPut(
    requestId: String?,
    namespace: String,
    key: String,
    value: String?,
    valueType: String,
  ) = record("requestSettingsPut", requestId, namespace, key, value, valueType)

  override fun requestSettingsList(requestId: String?, namespace: String) =
    record("requestSettingsList", requestId, namespace)

  override fun requestInstalledPackages(requestId: String?, includeSystem: Boolean, userId: Int?) =
    record("requestInstalledPackages", requestId, includeSystem, userId)

  override fun requestPackageInfo(
    requestId: String?,
    packageName: String,
    includePermissions: Boolean,
  ) = record("requestPackageInfo", requestId, packageName, includePermissions)

  override fun requestLaunchIntent(requestId: String?, packageName: String) =
    record("requestLaunchIntent", requestId, packageName)
}
