package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.protocol.NodeSelector

/**
 * The device actions a decoded [dev.jasonpearson.automobile.protocol.WebSocketRequest] can trigger.
 *
 * [CtrlProxyMessageHandler] dispatches each sealed request to exactly one of these methods. The
 * on-device [CtrlProxy] service implements them (mostly by delegating to its `perform*`/`handle*`
 * methods); tests provide a recording fake. Every method is abstract and non-null so the compiler
 * guarantees each action is wired — replacing the previous bag of ~43 nullable callback lambdas.
 *
 * `add_highlight` takes the Android render-model [HighlightShape]; the handler converts the wire
 * type before calling it. `set_network_mock_rules` receives pre-encoded JSON because the SDK store
 * consumes a JSON string.
 */
interface CtrlProxyActions {
  fun requestHierarchy(disableAllFiltering: Boolean)

  fun requestHierarchy(
    disableAllFiltering: Boolean,
    maxDepth: Int?,
    maxNodes: Int?,
  ) = requestHierarchy(disableAllFiltering)

  fun requestHierarchyIfStale(sinceTimestamp: Long)

  fun setHierarchyInterval(intervalMs: Long?)

  fun requestScreenshot(requestId: String?)

  // Coordinate params are `Double` so fractional wire values pass through untruncated to the
  // gesture engine (which builds float `Path`s). `offset`, durations, and `rotationDegrees` are not
  // coordinates and stay their original types. Symmetric to iOS; see #2927 / WebSocketRequest.kt.
  fun requestSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
  )

  fun requestSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
    frameContext: String?,
  ) = requestSwipe(requestId, x1, y1, x2, y2, duration)

  fun requestTapCoordinates(requestId: String?, x: Double, y: Double, duration: Long)

  fun requestTapCoordinates(
    requestId: String?,
    x: Double,
    y: Double,
    duration: Long,
    frameContext: String?,
  ) = requestTapCoordinates(requestId, x, y, duration)

  fun requestTwoFingerSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
    offset: Int,
  )

  fun requestDrag(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    pressDurationMs: Long,
    dragDurationMs: Long,
    holdDurationMs: Long,
  )

  fun requestDrag(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    pressDurationMs: Long,
    dragDurationMs: Long,
    holdDurationMs: Long,
    frameContext: String?,
  ) = requestDrag(requestId, x1, y1, x2, y2, pressDurationMs, dragDurationMs, holdDurationMs)

  fun requestPinch(
    requestId: String?,
    centerX: Double,
    centerY: Double,
    distanceStart: Double,
    distanceEnd: Double,
    rotationDegrees: Float,
    duration: Long,
  )

  // Streaming gesture input: one live drag arrives as a start, incremental moves sharing a
  // `gestureId`, and an end. The runner chains them into a single continued AccessibilityService
  // gesture so the device tracks the pointer in real time. Coordinates are `Double` for the same
  // reason swipe/tap are — fractional wire values reach the float `Path` engine untruncated.
  fun requestGestureStart(requestId: String?, gestureId: String, x: Double, y: Double)

  fun requestGestureMove(requestId: String?, gestureId: String, x: Double, y: Double)

  fun requestGestureEnd(
    requestId: String?,
    gestureId: String,
    x: Double,
    y: Double,
    cancel: Boolean,
  )

  fun requestSetText(
    requestId: String?,
    text: String,
    resourceId: String?,
    dismissKeyboard: Boolean,
  )

  fun requestSetText(
    requestId: String?,
    text: String,
    resourceId: String?,
    dismissKeyboard: Boolean,
    frameContext: String?,
  ) = requestSetText(requestId, text, resourceId, dismissKeyboard)

  fun requestInsertText(requestId: String?, text: String)

  fun requestImeAction(requestId: String?, action: String)

  fun requestImeAction(requestId: String?, action: String, frameContext: String?) =
    requestImeAction(requestId, action)

  fun requestSelectAll(requestId: String?)

  fun requestAction(
    requestId: String?,
    action: String,
    resourceId: String?,
    selector: NodeSelector?,
  )

  fun requestActivateAccessibilityLink(
    requestId: String?,
    text: String,
    occurrence: Int,
    selector: NodeSelector?,
  )

  fun requestClipboard(requestId: String?, action: String, text: String?)

  fun installCaCert(requestId: String?, certificate: String)

  fun installCaCertFromPath(requestId: String?, devicePath: String)

  fun removeCaCert(requestId: String?, alias: String?, certificate: String?)

  fun requestGlobalAction(requestId: String?, action: String)

  fun requestGlobalAction(requestId: String?, action: String, frameContext: String?) =
    requestGlobalAction(requestId, action)

  fun validateFrameContext(requestId: String?, frameContext: String) = Unit

  fun requestDeviceInfo(requestId: String?)

  fun getDeviceOwnerStatus(requestId: String?)

  fun getPermission(requestId: String?, permission: String?, requestPermission: Boolean?)

  fun setRecompositionTracking(enabled: Boolean)

  fun setAccessibilityFlags(
    includeNotImportantViews: Boolean,
    reportViewIds: Boolean,
    retrieveInteractiveWindows: Boolean,
    occlusionEnabled: Boolean,
  )

  fun setNetworkMockRules(rulesJson: String)

  fun setNetworkErrorSimulation(
    enabled: Boolean,
    errorType: String?,
    limit: Int?,
    expiresAtEpochMs: Long?,
  )

  fun getCurrentFocus(requestId: String?)

  fun getTraversalOrder(requestId: String?)

  fun addHighlight(requestId: String?, highlightId: String?, shape: HighlightShape?)

  fun listPreferenceFiles(requestId: String?, packageName: String)

  fun getPreferences(requestId: String?, packageName: String, fileName: String)

  fun listDataStores(requestId: String?, packageName: String, adapterName: String)

  fun getDataStore(
    requestId: String?,
    packageName: String,
    adapterName: String,
    storeName: String,
  )

  fun subscribeStorage(requestId: String?, packageName: String, fileName: String)

  fun unsubscribeStorage(requestId: String?, packageName: String, fileName: String)

  fun getPreference(requestId: String?, packageName: String, fileName: String, key: String)

  fun setPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
    value: String?,
    type: String,
  )

  fun removePreference(requestId: String?, packageName: String, fileName: String, key: String)

  fun clearPreferences(requestId: String?, packageName: String, fileName: String)

  fun startRecording()

  fun stopRecording()

  fun requestSettingsGet(requestId: String?, namespace: String, key: String)

  fun requestSettingsPut(
    requestId: String?,
    namespace: String,
    key: String,
    value: String?,
    valueType: String,
  )

  fun requestSettingsList(requestId: String?, namespace: String)

  fun requestInstalledPackages(requestId: String?, includeSystem: Boolean, userId: Int?)

  fun requestPackageInfo(requestId: String?, packageName: String, includePermissions: Boolean)

  fun requestLaunchIntent(requestId: String?, packageName: String)
}
