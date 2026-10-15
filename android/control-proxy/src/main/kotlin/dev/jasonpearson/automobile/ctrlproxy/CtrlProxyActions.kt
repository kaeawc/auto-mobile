package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.protocol.NodeSelector
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
 * The device actions a decoded [dev.jasonpearson.automobile.protocol.WebSocketRequest] can trigger.
 *
 * [CtrlProxyMessageHandler] dispatches each sealed request to exactly one of these methods. The
 * on-device [CtrlProxy] service implements them (mostly by delegating to its `perform*`/`handle*`
 * methods); tests provide a recording fake. Every typed request method is abstract, so the compiler
 * guarantees each action is wired. Legacy optional hooks below retain their defaults.
 *
 * `add_highlight` takes the Android render-model [HighlightShape]; the handler converts the wire
 * type before calling it. `set_network_mock_rules` receives pre-encoded JSON because the SDK store
 * consumes a JSON string.
 */
interface CtrlProxyActions {
  suspend fun requestHierarchy(request: RequestHierarchy)

  fun requestHierarchyIfStale(sinceTimestamp: Long, requestId: String?)

  fun setHierarchyInterval(intervalMs: Long?)

  /**
   * [RequestScreenshot.hidePrototypes] hides CtrlProxy's prototype for this capture and restores it
   * afterward, whatever the capture's outcome (#9305).
   */
  fun requestScreenshot(request: RequestScreenshot)

  // Typed request coordinates are Double so fractional wire values reach the float Path engine
  // untruncated. Durations, offset, and rotationDegrees retain their protocol types (#2927).
  fun requestSwipe(request: RequestSwipe)

  fun requestDoubleTapCoordinates(
    requestId: String?,
    x: Double,
    y: Double,
    frameContext: String?,
    displayId: Int?,
  ) {
    throw UnsupportedOperationException("Atomic double tap is not supported")
  }

  fun requestTapCoordinates(request: RequestTapCoordinates)

  fun requestTwoFingerSwipe(request: RequestTwoFingerSwipe)

  fun requestDrag(request: RequestDrag)

  fun requestPinch(request: RequestPinch)

  // One live drag arrives as a start, incremental moves sharing a gestureId, and an end. The
  // runner chains them into one continued AccessibilityService gesture.
  fun requestGestureStart(request: RequestGestureStart)

  fun requestGestureMove(requestId: String?, gestureId: String, x: Double, y: Double)

  fun requestGestureEnd(
    requestId: String?,
    gestureId: String,
    x: Double,
    y: Double,
    cancel: Boolean,
  )

  suspend fun requestSetText(request: RequestSetText)

  fun requestInsertTextState(requestId: String?) {}

  fun requestInsertText(request: RequestInsertText)

  fun requestCommitText(request: RequestCommitText)

  fun requestCancelImeCommit(requestId: String?, targetRequestId: String) {}

  fun requestSetKeyboardProfile(requestId: String?, profileId: String)

  fun requestListKeyboardProfiles(requestId: String?, supportedCatalogVersions: List<Int>)

  fun requestImeAction(request: RequestImeAction)

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

  fun requestGlobalAction(request: RequestGlobalAction)

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

  /** [reset] starts a same-id show fresh instead of replacing the prototype in place. */
  fun showPrototype(
    requestId: String?,
    spec: PrototypeSpec,
    displayId: Int?,
    reset: Boolean,
    appearance: PrototypeAppearanceOverride?,
    replaceOthers: Boolean = true,
  )

  fun dismissPrototype(requestId: String?, id: String?, all: Boolean?)

  fun patchPrototype(requestId: String?, id: String, baseRevision: Long?, ops: JsonArray)

  fun inspectPrototypes(requestId: String?)

  fun savePrototype(requestId: String?, spec: PrototypeSpec, label: String, icon: String?)

  fun pinSavedPrototype(requestId: String?, id: String, icon: String?)

  fun listSavedPrototypes(requestId: String?)

  fun deleteSavedPrototype(requestId: String?, id: String)

  fun putPrototypeAsset(requestId: String?, id: String, mimeType: String, dataBase64: String)

  fun removePrototypeAsset(requestId: String?, id: String)

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
