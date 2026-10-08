package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.protocol.ImeTextDelivery
import dev.jasonpearson.automobile.protocol.NodeSelector
import dev.jasonpearson.automobile.protocol.OverlaySpec

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
  suspend fun requestHierarchy(disableAllFiltering: Boolean, requestId: String?)

  suspend fun requestHierarchy(
    disableAllFiltering: Boolean,
    maxDepth: Int?,
    maxNodes: Int?,
    displayId: Int? = null,
    requestId: String? = null,
  ) = requestHierarchy(disableAllFiltering, requestId)

  fun requestHierarchyIfStale(sinceTimestamp: Long, requestId: String?)

  fun setHierarchyInterval(intervalMs: Long?)

  fun requestScreenshot(requestId: String?)

  fun requestScreenshot(requestId: String?, displayId: Int?) = requestScreenshot(requestId)

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

  fun requestDoubleTapCoordinates(
    requestId: String?,
    x: Double,
    y: Double,
    frameContext: String?,
    displayId: Int?,
  ) {
    throw UnsupportedOperationException("Atomic double tap is not supported")
  }

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

  fun requestTapCoordinates(
    requestId: String?,
    x: Double,
    y: Double,
    duration: Long,
    frameContext: String?,
    displayId: Int?,
  ) = requestTapCoordinates(requestId, x, y, duration, frameContext)

  fun requestSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
    frameContext: String?,
    displayId: Int?,
  ) = requestSwipe(requestId, x1, y1, x2, y2, duration, frameContext)

  fun requestTwoFingerSwipe(
    requestId: String?,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
    duration: Long,
    offset: Int,
    displayId: Int?,
  ) = requestTwoFingerSwipe(requestId, x1, y1, x2, y2, duration, offset)

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
    displayId: Int?,
  ) =
    requestDrag(
      requestId,
      x1,
      y1,
      x2,
      y2,
      pressDurationMs,
      dragDurationMs,
      holdDurationMs,
      frameContext,
    )

  fun requestPinch(
    requestId: String?,
    centerX: Double,
    centerY: Double,
    distanceStart: Double,
    distanceEnd: Double,
    rotationDegrees: Float,
    duration: Long,
    displayId: Int?,
  ) =
    requestPinch(requestId, centerX, centerY, distanceStart, distanceEnd, rotationDegrees, duration)

  fun requestGestureStart(
    requestId: String?,
    gestureId: String,
    x: Double,
    y: Double,
    displayId: Int?,
  ) = requestGestureStart(requestId, gestureId, x, y)

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

  suspend fun requestSetText(
    requestId: String?,
    text: String,
    resourceId: String?,
    dismissKeyboard: Boolean,
  )

  suspend fun requestSetText(
    requestId: String?,
    text: String,
    resourceId: String?,
    dismissKeyboard: Boolean,
    frameContext: String?,
  ) = requestSetText(requestId, text, resourceId, dismissKeyboard)

  fun requestInsertTextState(requestId: String?) {}

  fun requestInsertText(
    requestId: String?,
    text: String,
    expectedSuffix: String?,
    acceptsCaretNotPlaced: Boolean,
    precedingState: dev.jasonpearson.automobile.protocol.InsertTextState?,
  ) = requestInsertText(requestId, text, expectedSuffix, acceptsCaretNotPlaced)

  fun requestInsertText(requestId: String?, text: String)

  fun requestInsertText(requestId: String?, text: String, expectedSuffix: String?) =
    requestInsertText(requestId, text)

  fun requestInsertText(
    requestId: String?,
    text: String,
    expectedSuffix: String?,
    acceptsCaretNotPlaced: Boolean,
  ) = requestInsertText(requestId, text, expectedSuffix)

  fun requestCommitText(requestId: String?, text: String, priorImeId: String?)

  fun requestCommitText(
    requestId: String?,
    text: String,
    priorImeId: String?,
    delivery: ImeTextDelivery,
  ) = requestCommitText(requestId, text, priorImeId)

  fun requestCommitText(
    requestId: String?,
    text: String,
    priorImeId: String?,
    delivery: ImeTextDelivery,
    timeoutMs: Long?,
  ) = requestCommitText(requestId, text, priorImeId, delivery)

  fun requestCancelImeCommit(requestId: String?, targetRequestId: String) {}

  fun requestSetKeyboardProfile(requestId: String?, profileId: String)

  fun requestListKeyboardProfiles(requestId: String?, supportedCatalogVersions: List<Int>)

  fun requestImeAction(requestId: String?, action: String)

  fun requestImeAction(requestId: String?, action: String, frameContext: String?) =
    requestImeAction(requestId, action)

  fun requestSelectAll(requestId: String?)

  fun requestClickFocusedInput(requestId: String?)

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

  /**
   * Pushes the rule list to the app's rule store. A non-null [requestId] asks for a
   * `set_network_mock_rules_result` reply reporting the rules the device engine rejected
   * (issue #10101); null keeps the fire-and-forget broadcast.
   */
  fun setNetworkMockRules(requestId: String?, rulesJson: String)

  fun setNetworkErrorSimulation(
    enabled: Boolean,
    errorType: String?,
    limit: Int?,
    expiresAtEpochMs: Long?,
    remainingMs: Long?,
  )

  fun getCurrentFocus(requestId: String?)

  fun getTraversalOrder(requestId: String?)

  fun addHighlight(requestId: String?, highlightId: String?, shape: HighlightShape?)

  /** [reset] starts a same-id show fresh instead of replacing the overlay in place. */
  fun showOverlay(requestId: String?, spec: OverlaySpec, displayId: Int?, reset: Boolean)

  fun dismissOverlay(requestId: String?, id: String?, all: Boolean?)

  fun putOverlayAsset(requestId: String?, id: String, mimeType: String, dataBase64: String)

  fun removeOverlayAsset(requestId: String?, id: String)

  fun listPreferenceFiles(requestId: String?, packageName: String)

  fun getPreferences(requestId: String?, packageName: String, fileName: String)

  fun discoverKeystore(requestId: String?, packageName: String)

  fun getSdkCapabilities(requestId: String?, packageName: String, userId: Int?)

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
