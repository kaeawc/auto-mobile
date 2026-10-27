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
import dev.jasonpearson.automobile.protocol.SetPreference
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

  suspend fun requestHierarchyIfStale(sinceTimestamp: Long, requestId: String?)

  suspend fun setHierarchyInterval(intervalMs: Long?)

  /**
   * [RequestScreenshot.hidePrototypes] hides CtrlProxy's prototype for this capture and restores it
   * afterward, whatever the capture's outcome (#9305).
   */
  suspend fun requestScreenshot(request: RequestScreenshot)

  // Typed request coordinates are Double so fractional wire values reach the float Path engine
  // untruncated. Durations, offset, and rotationDegrees retain their protocol types (#2927).
  suspend fun requestSwipe(request: RequestSwipe)

  suspend fun requestDoubleTapCoordinates(
    requestId: String?,
    x: Double,
    y: Double,
    frameContext: String?,
    displayId: Int?,
  ) {
    throw UnsupportedOperationException("Atomic double tap is not supported")
  }

  suspend fun requestTapCoordinates(request: RequestTapCoordinates)

  suspend fun requestTwoFingerSwipe(request: RequestTwoFingerSwipe)

  suspend fun requestDrag(request: RequestDrag)

  suspend fun requestPinch(request: RequestPinch)

  // One live drag arrives as a start, incremental moves sharing a gestureId, and an end. The
  // runner chains them into one continued AccessibilityService gesture.
  suspend fun requestGestureStart(request: RequestGestureStart)

  suspend fun requestGestureMove(requestId: String?, gestureId: String, x: Double, y: Double)

  suspend fun requestGestureEnd(
    requestId: String?,
    gestureId: String,
    x: Double,
    y: Double,
    cancel: Boolean,
  )

  suspend fun requestSetText(request: RequestSetText)

  suspend fun requestInsertTextState(requestId: String?) {}

  suspend fun requestInsertText(request: RequestInsertText)

  suspend fun requestCommitText(request: RequestCommitText)

  suspend fun requestCancelImeCommit(requestId: String?, targetRequestId: String) {}

  suspend fun requestSetKeyboardProfile(requestId: String?, profileId: String)

  suspend fun requestListKeyboardProfiles(requestId: String?, supportedCatalogVersions: List<Int>)

  suspend fun requestImeAction(request: RequestImeAction)

  suspend fun requestSelectAll(requestId: String?)

  suspend fun requestClickFocusedInput(requestId: String?)

  suspend fun requestAction(
    requestId: String?,
    action: String,
    resourceId: String?,
    selector: NodeSelector?,
    arguments: NodeActionArguments = NodeActionArguments(),
  )

  suspend fun requestActivateAccessibilityLink(
    requestId: String?,
    text: String,
    occurrence: Int,
    selector: NodeSelector?,
  )

  suspend fun requestClipboard(requestId: String?, action: String, text: String?)

  suspend fun installCaCert(requestId: String?, certificate: String)

  suspend fun installCaCertFromPath(requestId: String?, devicePath: String)

  suspend fun removeCaCert(requestId: String?, alias: String?, certificate: String?)

  suspend fun requestGlobalAction(request: RequestGlobalAction)

  suspend fun validateFrameContext(requestId: String?, frameContext: String) = Unit

  suspend fun requestDeviceInfo(requestId: String?)

  suspend fun getDeviceOwnerStatus(requestId: String?)

  suspend fun getPermission(requestId: String?, permission: String?, requestPermission: Boolean?)

  suspend fun setRecompositionTracking(enabled: Boolean)

  suspend fun setAccessibilityFlags(
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
  suspend fun setNetworkMockRules(requestId: String?, rulesJson: String)

  suspend fun setNetworkErrorSimulation(
    enabled: Boolean,
    errorType: String?,
    limit: Int?,
    expiresAtEpochMs: Long?,
    remainingMs: Long?,
  )

  suspend fun getCurrentFocus(requestId: String?)

  suspend fun getTraversalOrder(requestId: String?)

  suspend fun addHighlight(requestId: String?, highlightId: String?, shape: HighlightShape?)

  /** [reset] starts a same-id show fresh instead of replacing the prototype in place. */
  suspend fun showPrototype(
    requestId: String?,
    spec: PrototypeSpec,
    displayId: Int?,
    reset: Boolean,
    appearance: PrototypeAppearanceOverride?,
    replaceOthers: Boolean = true,
    locale: String? = null,
  )

  suspend fun dismissPrototype(requestId: String?, id: String?, all: Boolean?)

  suspend fun patchPrototype(requestId: String?, id: String, baseRevision: Long?, ops: JsonArray)

  suspend fun inspectPrototypes(requestId: String?)

  suspend fun savePrototype(requestId: String?, spec: PrototypeSpec, label: String, icon: String?)

  suspend fun pinSavedPrototype(requestId: String?, id: String, icon: String?)

  suspend fun listSavedPrototypes(requestId: String?)

  suspend fun deleteSavedPrototype(requestId: String?, id: String)

  suspend fun advancePrototypeClock(requestId: String?, id: String, advanceTimeMs: Int)

  suspend fun clearPrototypeStorage(requestId: String?, id: String)

  suspend fun putPrototypeAsset(
    requestId: String?,
    id: String,
    mimeType: String,
    dataBase64: String,
  )

  suspend fun removePrototypeAsset(requestId: String?, id: String)

  suspend fun listPreferenceFiles(requestId: String?, packageName: String)

  suspend fun getPreferences(requestId: String?, packageName: String, fileName: String)

  suspend fun discoverKeystore(requestId: String?, packageName: String)

  suspend fun getSdkCapabilities(requestId: String?, packageName: String, userId: Int?)

  suspend fun listDataStores(requestId: String?, packageName: String, adapterName: String)

  suspend fun getDataStore(
    requestId: String?,
    packageName: String,
    adapterName: String,
    storeName: String,
  )

  suspend fun subscribeStorage(requestId: String?, packageName: String, fileName: String)

  suspend fun unsubscribeStorage(requestId: String?, packageName: String, fileName: String)

  suspend fun getPreference(requestId: String?, packageName: String, fileName: String, key: String)

  suspend fun setPreference(request: SetPreference)

  suspend fun removePreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  )

  suspend fun clearPreferences(requestId: String?, packageName: String, fileName: String)

  suspend fun startRecording()

  suspend fun stopRecording()

  suspend fun requestSettingsGet(requestId: String?, namespace: String, key: String)

  suspend fun requestSettingsPut(
    requestId: String?,
    namespace: String,
    key: String,
    value: String?,
    valueType: String,
  )

  suspend fun requestSettingsList(requestId: String?, namespace: String)

  suspend fun requestInstalledPackages(requestId: String?, includeSystem: Boolean, userId: Int?)

  suspend fun requestPackageInfo(
    requestId: String?,
    packageName: String,
    includePermissions: Boolean,
  )

  suspend fun requestLaunchIntent(requestId: String?, packageName: String)
}
