package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.protocol.PrototypeAppearanceOverride
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.RequestCommitText
import dev.jasonpearson.automobile.protocol.RequestDrag
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
import kotlinx.serialization.json.JsonArray

/**
 * No-op [CtrlProxyActions] base for tests that only care about a couple of actions — subclass and
 * override just those. Keeps partial test doubles concise now that the interface is non-optional.
 */
open class NoOpCtrlProxyActions : CtrlProxyActions {
  val patches = mutableListOf<List<Any?>>()

  override suspend fun requestHierarchy(request: RequestHierarchy) {}

  override suspend fun requestHierarchyIfStale(sinceTimestamp: Long, requestId: String?) {}

  override suspend fun setHierarchyInterval(intervalMs: Long?) {}

  override suspend fun requestScreenshot(request: RequestScreenshot) {}

  override suspend fun requestSwipe(request: RequestSwipe) {}

  override suspend fun requestTapCoordinates(request: RequestTapCoordinates) {}

  override suspend fun requestTwoFingerSwipe(request: RequestTwoFingerSwipe) {}

  override suspend fun requestDrag(request: RequestDrag) {}

  override suspend fun requestPinch(request: RequestPinch) {}

  override suspend fun requestGestureStart(request: RequestGestureStart) {}

  override suspend fun requestGestureMove(
    requestId: String?,
    gestureId: String,
    x: Double,
    y: Double,
  ) {}

  override suspend fun requestGestureEnd(
    requestId: String?,
    gestureId: String,
    x: Double,
    y: Double,
    cancel: Boolean,
  ) {}

  override suspend fun requestSetText(request: RequestSetText) {}

  override suspend fun requestInsertText(request: RequestInsertText) {}

  override suspend fun requestCommitText(request: RequestCommitText) {}

  override suspend fun requestSetKeyboardProfile(requestId: String?, profileId: String) {}

  override suspend fun requestListKeyboardProfiles(
    requestId: String?,
    supportedCatalogVersions: List<Int>,
  ) {}

  override suspend fun requestImeAction(request: RequestImeAction) {}

  override suspend fun requestSelectAll(requestId: String?) {}

  override suspend fun requestClickFocusedInput(requestId: String?) {}

  override suspend fun requestAction(
    requestId: String?,
    action: String,
    resourceId: String?,
    selector: dev.jasonpearson.automobile.protocol.NodeSelector?,
  ) {}

  override suspend fun requestActivateAccessibilityLink(
    requestId: String?,
    text: String,
    occurrence: Int,
    selector: dev.jasonpearson.automobile.protocol.NodeSelector?,
  ) {}

  override suspend fun requestClipboard(requestId: String?, action: String, text: String?) {}

  override suspend fun installCaCert(requestId: String?, certificate: String) {}

  override suspend fun installCaCertFromPath(requestId: String?, devicePath: String) {}

  override suspend fun removeCaCert(requestId: String?, alias: String?, certificate: String?) {}

  override suspend fun requestGlobalAction(request: RequestGlobalAction) {}

  override suspend fun requestDeviceInfo(requestId: String?) {}

  override suspend fun getDeviceOwnerStatus(requestId: String?) {}

  override suspend fun getPermission(
    requestId: String?,
    permission: String?,
    requestPermission: Boolean?,
  ) {}

  override suspend fun setRecompositionTracking(enabled: Boolean) {}

  override suspend fun setAccessibilityFlags(
    includeNotImportantViews: Boolean,
    reportViewIds: Boolean,
    retrieveInteractiveWindows: Boolean,
    occlusionEnabled: Boolean,
  ) {}

  override suspend fun setNetworkMockRules(requestId: String?, rulesJson: String) {}

  override suspend fun setNetworkErrorSimulation(
    enabled: Boolean,
    errorType: String?,
    limit: Int?,
    expiresAtEpochMs: Long?,
    remainingMs: Long?,
  ) {}

  override suspend fun getCurrentFocus(requestId: String?) {}

  override suspend fun getTraversalOrder(requestId: String?) {}

  override suspend fun addHighlight(
    requestId: String?,
    highlightId: String?,
    shape: HighlightShape?,
  ) {}

  override suspend fun showPrototype(
    requestId: String?,
    spec: PrototypeSpec,
    displayId: Int?,
    reset: Boolean,
    appearance: PrototypeAppearanceOverride?,
    replaceOthers: Boolean,
  ) {}

  override suspend fun dismissPrototype(requestId: String?, id: String?, all: Boolean?) {}

  override suspend fun patchPrototype(
    requestId: String?,
    id: String,
    baseRevision: Long?,
    ops: JsonArray,
  ) {
    patches += listOf(requestId, id, baseRevision, ops)
  }

  override suspend fun inspectPrototypes(requestId: String?) {}

  override suspend fun putPrototypeAsset(
    requestId: String?,
    id: String,
    mimeType: String,
    dataBase64: String,
  ) {}

  override suspend fun savePrototype(
    requestId: String?,
    spec: PrototypeSpec,
    label: String,
    icon: String?,
  ) {}

  override suspend fun pinSavedPrototype(requestId: String?, id: String, icon: String?) {}

  override suspend fun listSavedPrototypes(requestId: String?) {}

  override suspend fun deleteSavedPrototype(requestId: String?, id: String) {}

  override suspend fun removePrototypeAsset(requestId: String?, id: String) {}

  override suspend fun listPreferenceFiles(requestId: String?, packageName: String) {}

  override suspend fun getPreferences(requestId: String?, packageName: String, fileName: String) {}

  override suspend fun discoverKeystore(requestId: String?, packageName: String) {}

  override suspend fun getSdkCapabilities(requestId: String?, packageName: String, userId: Int?) {}

  override suspend fun listDataStores(
    requestId: String?,
    packageName: String,
    adapterName: String,
  ) {}

  override suspend fun getDataStore(
    requestId: String?,
    packageName: String,
    adapterName: String,
    storeName: String,
  ) {}

  override suspend fun subscribeStorage(
    requestId: String?,
    packageName: String,
    fileName: String,
  ) {}

  override suspend fun unsubscribeStorage(
    requestId: String?,
    packageName: String,
    fileName: String,
  ) {}

  override suspend fun getPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) {}

  override suspend fun setPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
    value: String?,
    type: String,
  ) {}

  override suspend fun removePreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) {}

  override suspend fun clearPreferences(
    requestId: String?,
    packageName: String,
    fileName: String,
  ) {}

  override suspend fun startRecording() {}

  override suspend fun stopRecording() {}

  override suspend fun requestSettingsGet(requestId: String?, namespace: String, key: String) {}

  override suspend fun requestSettingsPut(
    requestId: String?,
    namespace: String,
    key: String,
    value: String?,
    valueType: String,
  ) {}

  override suspend fun requestSettingsList(requestId: String?, namespace: String) {}

  override suspend fun requestInstalledPackages(
    requestId: String?,
    includeSystem: Boolean,
    userId: Int?,
  ) {}

  override suspend fun requestPackageInfo(
    requestId: String?,
    packageName: String,
    includePermissions: Boolean,
  ) {}

  override suspend fun requestLaunchIntent(requestId: String?, packageName: String) {}
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

  override suspend fun requestHierarchy(request: RequestHierarchy) =
    record("requestHierarchy", request)

  override suspend fun requestHierarchyIfStale(sinceTimestamp: Long, requestId: String?) =
    record("requestHierarchyIfStale", sinceTimestamp, requestId)

  override suspend fun setHierarchyInterval(intervalMs: Long?) =
    record("setHierarchyInterval", intervalMs)

  override suspend fun requestScreenshot(request: RequestScreenshot) =
    record("requestScreenshot", request)

  override suspend fun requestSwipe(request: RequestSwipe) = record("requestSwipe", request)

  override suspend fun requestDoubleTapCoordinates(
    requestId: String?,
    x: Double,
    y: Double,
    frameContext: String?,
    displayId: Int?,
  ) = record("requestDoubleTapCoordinates", requestId, x, y, frameContext, displayId)

  override suspend fun requestTapCoordinates(request: RequestTapCoordinates) =
    record("requestTapCoordinates", request)

  override suspend fun requestTwoFingerSwipe(request: RequestTwoFingerSwipe) =
    record("requestTwoFingerSwipe", request)

  override suspend fun requestDrag(request: RequestDrag) = record("requestDrag", request)

  override suspend fun requestPinch(request: RequestPinch) = record("requestPinch", request)

  override suspend fun requestGestureStart(request: RequestGestureStart) =
    record("requestGestureStart", request)

  override suspend fun requestGestureMove(
    requestId: String?,
    gestureId: String,
    x: Double,
    y: Double,
  ) = record("requestGestureMove", requestId, gestureId, x, y)

  override suspend fun requestGestureEnd(
    requestId: String?,
    gestureId: String,
    x: Double,
    y: Double,
    cancel: Boolean,
  ) = record("requestGestureEnd", requestId, gestureId, x, y, cancel)

  override suspend fun requestSetText(request: RequestSetText) = record("requestSetText", request)

  override suspend fun requestInsertTextState(requestId: String?) =
    record("requestInsertTextState", requestId)

  override suspend fun requestInsertText(request: RequestInsertText) =
    record("requestInsertText", request)

  override suspend fun requestCommitText(request: RequestCommitText) =
    record("requestCommitText", request)

  override suspend fun requestCancelImeCommit(requestId: String?, targetRequestId: String) =
    record("requestCancelImeCommit", requestId, targetRequestId)

  override suspend fun requestSetKeyboardProfile(requestId: String?, profileId: String) =
    record("requestSetKeyboardProfile", requestId, profileId)

  override suspend fun requestListKeyboardProfiles(
    requestId: String?,
    supportedCatalogVersions: List<Int>,
  ) = record("requestListKeyboardProfiles", requestId, supportedCatalogVersions)

  override suspend fun requestImeAction(request: RequestImeAction) =
    record("requestImeAction", request)

  override suspend fun requestSelectAll(requestId: String?) = record("requestSelectAll", requestId)

  override suspend fun requestClickFocusedInput(requestId: String?) =
    record("requestClickFocusedInput", requestId)

  override suspend fun requestAction(
    requestId: String?,
    action: String,
    resourceId: String?,
    selector: dev.jasonpearson.automobile.protocol.NodeSelector?,
  ) = record("requestAction", requestId, action, resourceId, selector)

  override suspend fun requestActivateAccessibilityLink(
    requestId: String?,
    text: String,
    occurrence: Int,
    selector: dev.jasonpearson.automobile.protocol.NodeSelector?,
  ) = record("requestActivateAccessibilityLink", requestId, text, occurrence, selector)

  override suspend fun requestClipboard(requestId: String?, action: String, text: String?) =
    record("requestClipboard", requestId, action, text)

  override suspend fun installCaCert(requestId: String?, certificate: String) =
    record("installCaCert", requestId, certificate)

  override suspend fun installCaCertFromPath(requestId: String?, devicePath: String) =
    record("installCaCertFromPath", requestId, devicePath)

  override suspend fun removeCaCert(requestId: String?, alias: String?, certificate: String?) =
    record("removeCaCert", requestId, alias, certificate)

  override suspend fun requestGlobalAction(request: RequestGlobalAction) =
    record("requestGlobalAction", request)

  override suspend fun validateFrameContext(requestId: String?, frameContext: String) =
    record("validateFrameContext", requestId, frameContext)

  override suspend fun requestDeviceInfo(requestId: String?) =
    record("requestDeviceInfo", requestId)

  override suspend fun getDeviceOwnerStatus(requestId: String?) =
    record("getDeviceOwnerStatus", requestId)

  override suspend fun getPermission(
    requestId: String?,
    permission: String?,
    requestPermission: Boolean?,
  ) = record("getPermission", requestId, permission, requestPermission)

  override suspend fun setRecompositionTracking(enabled: Boolean) =
    record("setRecompositionTracking", enabled)

  override suspend fun setAccessibilityFlags(
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

  override suspend fun setNetworkMockRules(requestId: String?, rulesJson: String) =
    record("setNetworkMockRules", rulesJson, requestId)

  override suspend fun setNetworkErrorSimulation(
    enabled: Boolean,
    errorType: String?,
    limit: Int?,
    expiresAtEpochMs: Long?,
    remainingMs: Long?,
  ) = record("setNetworkErrorSimulation", enabled, errorType, limit, expiresAtEpochMs, remainingMs)

  override suspend fun getCurrentFocus(requestId: String?) = record("getCurrentFocus", requestId)

  override suspend fun getTraversalOrder(requestId: String?) =
    record("getTraversalOrder", requestId)

  override suspend fun addHighlight(
    requestId: String?,
    highlightId: String?,
    shape: HighlightShape?,
  ) = record("addHighlight", requestId, highlightId, shape)

  override suspend fun showPrototype(
    requestId: String?,
    spec: PrototypeSpec,
    displayId: Int?,
    reset: Boolean,
    appearance: PrototypeAppearanceOverride?,
    replaceOthers: Boolean,
  ) = record("showPrototype", requestId, spec, displayId, reset, appearance, replaceOthers)

  override suspend fun dismissPrototype(requestId: String?, id: String?, all: Boolean?) =
    record("dismissPrototype", requestId, id, all)

  override suspend fun patchPrototype(
    requestId: String?,
    id: String,
    baseRevision: Long?,
    ops: JsonArray,
  ) = record("patchPrototype", requestId, id, baseRevision, ops)

  override suspend fun inspectPrototypes(requestId: String?) =
    record("inspectPrototypes", requestId)

  override suspend fun putPrototypeAsset(
    requestId: String?,
    id: String,
    mimeType: String,
    dataBase64: String,
  ) = record("putPrototypeAsset", requestId, id, mimeType, dataBase64)

  override suspend fun savePrototype(
    requestId: String?,
    spec: PrototypeSpec,
    label: String,
    icon: String?,
  ) = record("savePrototype", requestId, spec, label, icon)

  override suspend fun pinSavedPrototype(requestId: String?, id: String, icon: String?) =
    record("pinSavedPrototype", requestId, id, icon)

  override suspend fun listSavedPrototypes(requestId: String?) =
    record("listSavedPrototypes", requestId)

  override suspend fun deleteSavedPrototype(requestId: String?, id: String) =
    record("deleteSavedPrototype", requestId, id)

  override suspend fun removePrototypeAsset(requestId: String?, id: String) =
    record("removePrototypeAsset", requestId, id)

  override suspend fun listPreferenceFiles(requestId: String?, packageName: String) =
    record("listPreferenceFiles", requestId, packageName)

  override suspend fun getPreferences(requestId: String?, packageName: String, fileName: String) =
    record("getPreferences", requestId, packageName, fileName)

  override suspend fun discoverKeystore(requestId: String?, packageName: String) =
    record("discoverKeystore", requestId, packageName)

  override suspend fun getSdkCapabilities(requestId: String?, packageName: String, userId: Int?) =
    record("getSdkCapabilities", requestId, packageName, userId)

  override suspend fun listDataStores(
    requestId: String?,
    packageName: String,
    adapterName: String,
  ) = record("listDataStores", requestId, packageName, adapterName)

  override suspend fun getDataStore(
    requestId: String?,
    packageName: String,
    adapterName: String,
    storeName: String,
  ) = record("getDataStore", requestId, packageName, adapterName, storeName)

  override suspend fun subscribeStorage(requestId: String?, packageName: String, fileName: String) =
    record("subscribeStorage", requestId, packageName, fileName)

  override suspend fun unsubscribeStorage(
    requestId: String?,
    packageName: String,
    fileName: String,
  ) = record("unsubscribeStorage", requestId, packageName, fileName)

  override suspend fun getPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) = record("getPreference", requestId, packageName, fileName, key)

  override suspend fun setPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
    value: String?,
    type: String,
  ) = record("setPreference", requestId, packageName, fileName, key, value, type)

  override suspend fun removePreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) = record("removePreference", requestId, packageName, fileName, key)

  override suspend fun clearPreferences(requestId: String?, packageName: String, fileName: String) =
    record("clearPreferences", requestId, packageName, fileName)

  override suspend fun startRecording() = record("startRecording")

  override suspend fun stopRecording() = record("stopRecording")

  override suspend fun requestSettingsGet(requestId: String?, namespace: String, key: String) =
    record("requestSettingsGet", requestId, namespace, key)

  override suspend fun requestSettingsPut(
    requestId: String?,
    namespace: String,
    key: String,
    value: String?,
    valueType: String,
  ) = record("requestSettingsPut", requestId, namespace, key, value, valueType)

  override suspend fun requestSettingsList(requestId: String?, namespace: String) =
    record("requestSettingsList", requestId, namespace)

  override suspend fun requestInstalledPackages(
    requestId: String?,
    includeSystem: Boolean,
    userId: Int?,
  ) = record("requestInstalledPackages", requestId, includeSystem, userId)

  override suspend fun requestPackageInfo(
    requestId: String?,
    packageName: String,
    includePermissions: Boolean,
  ) = record("requestPackageInfo", requestId, packageName, includePermissions)

  override suspend fun requestLaunchIntent(requestId: String?, packageName: String) =
    record("requestLaunchIntent", requestId, packageName)
}
