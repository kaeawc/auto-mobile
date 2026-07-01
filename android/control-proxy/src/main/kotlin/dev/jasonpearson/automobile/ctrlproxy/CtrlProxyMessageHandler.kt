package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.protocol.AddHighlight
import dev.jasonpearson.automobile.protocol.ClearPreferences
import dev.jasonpearson.automobile.protocol.RequestClipboard
import dev.jasonpearson.automobile.protocol.GetCurrentFocus
import dev.jasonpearson.automobile.protocol.GetDeviceOwnerStatus
import dev.jasonpearson.automobile.protocol.GetPermission
import dev.jasonpearson.automobile.protocol.GetPreference
import dev.jasonpearson.automobile.protocol.GetPreferences
import dev.jasonpearson.automobile.protocol.GetTraversalOrder
import dev.jasonpearson.automobile.protocol.InstallCaCert
import dev.jasonpearson.automobile.protocol.InstallCaCertFromPath
import dev.jasonpearson.automobile.protocol.ListPreferenceFiles
import dev.jasonpearson.automobile.protocol.NetworkMockRuleDto
import dev.jasonpearson.automobile.protocol.RemoveCaCert
import dev.jasonpearson.automobile.protocol.RemovePreference
import dev.jasonpearson.automobile.protocol.RequestAction
import dev.jasonpearson.automobile.protocol.RequestDeviceInfo
import dev.jasonpearson.automobile.protocol.RequestDrag
import dev.jasonpearson.automobile.protocol.RequestGlobalAction
import dev.jasonpearson.automobile.protocol.RequestHierarchy
import dev.jasonpearson.automobile.protocol.RequestHierarchyIfStale
import dev.jasonpearson.automobile.protocol.RequestHitTest
import dev.jasonpearson.automobile.protocol.RequestImeAction
import dev.jasonpearson.automobile.protocol.RequestInstalledPackages
import dev.jasonpearson.automobile.protocol.RequestLaunchIntent
import dev.jasonpearson.automobile.protocol.RequestPackageInfo
import dev.jasonpearson.automobile.protocol.RequestPinch
import dev.jasonpearson.automobile.protocol.RequestScreenshot
import dev.jasonpearson.automobile.protocol.RequestSelectAll
import dev.jasonpearson.automobile.protocol.RequestSettingsGet
import dev.jasonpearson.automobile.protocol.RequestSettingsList
import dev.jasonpearson.automobile.protocol.RequestSettingsPut
import dev.jasonpearson.automobile.protocol.RequestSetText
import dev.jasonpearson.automobile.protocol.RequestSwipe
import dev.jasonpearson.automobile.protocol.RequestTapCoordinates
import dev.jasonpearson.automobile.protocol.RequestTwoFingerSwipe
import dev.jasonpearson.automobile.protocol.SetAccessibilityFlags
import dev.jasonpearson.automobile.protocol.SetNetworkErrorSimulation
import dev.jasonpearson.automobile.protocol.SetNetworkMockRules
import dev.jasonpearson.automobile.protocol.SetPreference
import dev.jasonpearson.automobile.protocol.SetRecompositionTracking
import dev.jasonpearson.automobile.protocol.StartRecording
import dev.jasonpearson.automobile.protocol.StopRecording
import dev.jasonpearson.automobile.protocol.SubscribeStorage
import dev.jasonpearson.automobile.protocol.UnsubscribeStorage
import dev.jasonpearson.automobile.protocol.WebSocketMessageHandler
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * Typed [WebSocketMessageHandler] that dispatches each sealed [WebSocketRequest] to the matching
 * action callback. This replaces the legacy flat-DTO + 43-case `when(type: String)` decode path in
 * [WebSocketServer]: the `when (request)` below is exhaustive over the sealed hierarchy, so the
 * compiler fails the build if a new request type is added without a branch here.
 *
 * The callbacks are the same lambdas the on-device [CtrlProxy] service supplies; this class is a
 * pure dispatch move (it performs no Android I/O) so it can be unit-tested without Robolectric.
 * Every current command is fire-and-forget — the underlying action broadcasts its own response
 * asynchronously — so [handleMessage] always returns `null`.
 *
 * @param log diagnostic sink for the few commands with no wired action (e.g. an ahead-of-need
 *   request type). Defaults to a no-op so tests stay Android-free; production wires it to `Log`.
 */
class CtrlProxyMessageHandler(
    private val log: (String) -> Unit = {},
    private val onRequestHierarchy: ((disableAllFiltering: Boolean) -> Unit)? = null,
    private val onRequestHierarchyIfStale: ((sinceTimestamp: Long) -> Unit)? = null,
    private val onRequestScreenshot: ((requestId: String?) -> Unit)? = null,
    private val onRequestSwipe:
        ((requestId: String?, x1: Int, y1: Int, x2: Int, y2: Int, duration: Long) -> Unit)? =
        null,
    private val onRequestTapCoordinates:
        ((requestId: String?, x: Int, y: Int, duration: Long) -> Unit)? =
        null,
    private val onRequestTwoFingerSwipe:
        ((
            requestId: String?,
            x1: Int,
            y1: Int,
            x2: Int,
            y2: Int,
            duration: Long,
            offset: Int,
        ) -> Unit)? =
        null,
    private val onRequestDrag:
        ((
            requestId: String?,
            x1: Int,
            y1: Int,
            x2: Int,
            y2: Int,
            pressDurationMs: Long,
            dragDurationMs: Long,
            holdDurationMs: Long,
        ) -> Unit)? =
        null,
    private val onRequestPinch:
        ((
            requestId: String?,
            centerX: Int,
            centerY: Int,
            distanceStart: Int,
            distanceEnd: Int,
            rotationDegrees: Float,
            duration: Long,
        ) -> Unit)? =
        null,
    private val onRequestSetText:
        ((requestId: String?, text: String, resourceId: String?, dismissKeyboard: Boolean) -> Unit)? =
        null,
    private val onRequestImeAction: ((requestId: String?, action: String) -> Unit)? = null,
    private val onRequestSelectAll: ((requestId: String?) -> Unit)? = null,
    private val onRequestAction:
        ((requestId: String?, action: String, resourceId: String?) -> Unit)? =
        null,
    private val onRequestClipboard: ((requestId: String?, action: String, text: String?) -> Unit)? =
        null,
    private val onRequestInstallCaCert: ((requestId: String?, certificate: String) -> Unit)? = null,
    private val onRequestRemoveCaCert:
        ((requestId: String?, alias: String?, certificate: String?) -> Unit)? =
        null,
    private val onRequestInstallCaCertFromPath:
        ((requestId: String?, devicePath: String) -> Unit)? =
        null,
    private val onRequestGlobalAction: ((requestId: String?, action: String) -> Unit)? = null,
    private val onRequestDeviceInfo: ((requestId: String?) -> Unit)? = null,
    private val onGetDeviceOwnerStatus: ((requestId: String?) -> Unit)? = null,
    private val onGetPermission:
        ((requestId: String?, permission: String?, requestPermission: Boolean?) -> Unit)? =
        null,
    private val onSetRecompositionTracking: ((enabled: Boolean) -> Unit)? = null,
    private val onSetAccessibilityFlags:
        ((includeNotImportantViews: Boolean, reportViewIds: Boolean, retrieveInteractiveWindows: Boolean) -> Unit)? =
        null,
    private val onSetNetworkMockRules: ((rulesJson: String) -> Unit)? = null,
    private val onSetNetworkErrorSimulation:
        ((enabled: Boolean, errorType: String?, limit: Int?, expiresAtEpochMs: Long?) -> Unit)? =
        null,
    private val onGetCurrentFocus: ((requestId: String?) -> Unit)? = null,
    private val onGetTraversalOrder: ((requestId: String?) -> Unit)? = null,
    private val onAddHighlight:
        ((requestId: String?, highlightId: String?, shape: HighlightShape?) -> Unit)? =
        null,
    private val onListPreferenceFiles: ((requestId: String?, packageName: String) -> Unit)? = null,
    private val onGetPreferences:
        ((requestId: String?, packageName: String, fileName: String) -> Unit)? =
        null,
    private val onSubscribeStorage:
        ((requestId: String?, packageName: String, fileName: String) -> Unit)? =
        null,
    private val onUnsubscribeStorage:
        ((requestId: String?, packageName: String, fileName: String) -> Unit)? =
        null,
    private val onGetPreference:
        ((requestId: String?, packageName: String, fileName: String, key: String) -> Unit)? =
        null,
    private val onSetPreference:
        ((requestId: String?, packageName: String, fileName: String, key: String, value: String?, type: String) -> Unit)? =
        null,
    private val onRemovePreference:
        ((requestId: String?, packageName: String, fileName: String, key: String) -> Unit)? =
        null,
    private val onClearPreferences:
        ((requestId: String?, packageName: String, fileName: String) -> Unit)? =
        null,
    private val onStartRecording: (() -> Unit)? = null,
    private val onStopRecording: (() -> Unit)? = null,
    private val onRequestSettingsGet:
        ((requestId: String?, namespace: String, key: String) -> Unit)? =
        null,
    private val onRequestSettingsPut:
        ((requestId: String?, namespace: String, key: String, value: String?, valueType: String) -> Unit)? =
        null,
    private val onRequestSettingsList: ((requestId: String?, namespace: String) -> Unit)? = null,
    private val onRequestInstalledPackages:
        ((requestId: String?, includeSystem: Boolean, userId: Int?) -> Unit)? =
        null,
    private val onRequestPackageInfo:
        ((requestId: String?, packageName: String, includePermissions: Boolean) -> Unit)? =
        null,
    private val onRequestLaunchIntent: ((requestId: String?, packageName: String) -> Unit)? = null,
) : WebSocketMessageHandler {

  /** JSON used to re-encode the typed network mock rules into the string the SDK store expects. */
  private val json = Json { ignoreUnknownKeys = true }

  override suspend fun handleMessage(request: WebSocketRequest): WebSocketResponse? {
    // Exhaustive over the sealed hierarchy: adding a new WebSocketRequest subclass without a branch
    // here is a compile error, which is the whole point of retiring the string-typed `when`.
    when (request) {
      is RequestHierarchy -> onRequestHierarchy?.invoke(request.disableAllFiltering)
      is RequestHierarchyIfStale -> onRequestHierarchyIfStale?.invoke(request.sinceTimestamp)
      is RequestScreenshot -> onRequestScreenshot?.invoke(request.requestId)
      is RequestSwipe ->
          onRequestSwipe?.invoke(
              request.requestId,
              request.x1,
              request.y1,
              request.x2,
              request.y2,
              request.duration,
          )
      is RequestTapCoordinates ->
          onRequestTapCoordinates?.invoke(request.requestId, request.x, request.y, request.duration)
      is RequestTwoFingerSwipe ->
          onRequestTwoFingerSwipe?.invoke(
              request.requestId,
              request.x1,
              request.y1,
              request.x2,
              request.y2,
              request.duration,
              request.offset,
          )
      is RequestDrag ->
          onRequestDrag?.invoke(
              request.requestId,
              request.x1,
              request.y1,
              request.x2,
              request.y2,
              request.resolvedPressDurationMs,
              request.resolvedDragDurationMs,
              request.holdDurationMs,
          )
      is RequestPinch ->
          onRequestPinch?.invoke(
              request.requestId,
              request.centerX,
              request.centerY,
              request.distanceStart,
              request.distanceEnd,
              request.rotationDegrees,
              request.duration,
          )
      is RequestSetText ->
          onRequestSetText?.invoke(
              request.requestId,
              request.text,
              request.resourceId,
              request.dismissKeyboard,
          )
      is RequestImeAction -> onRequestImeAction?.invoke(request.requestId, request.action)
      is RequestSelectAll -> onRequestSelectAll?.invoke(request.requestId)
      is RequestAction ->
          onRequestAction?.invoke(request.requestId, request.action, request.resourceId)
      is RequestHitTest ->
          // Ahead-of-need: no TS client sends this and no device action is wired. Log loudly so a
          // future hit-test implementation notices the gap rather than silently dropping it.
          log("request_hit_test received (requestId=${request.requestId}) but no device handler is wired; ignoring")
      is RequestClipboard ->
          onRequestClipboard?.invoke(request.requestId, request.action, request.text)
      is InstallCaCert ->
          if (request.certificate.isNotBlank()) {
            onRequestInstallCaCert?.invoke(request.requestId, request.certificate)
          } else {
            log("install_ca_cert missing certificate; ignoring")
          }
      is InstallCaCertFromPath ->
          if (request.devicePath.isNotBlank()) {
            onRequestInstallCaCertFromPath?.invoke(request.requestId, request.devicePath)
          } else {
            log("install_ca_cert_from_path missing devicePath; ignoring")
          }
      is RemoveCaCert ->
          if (!request.alias.isNullOrBlank() || !request.certificate.isNullOrBlank()) {
            onRequestRemoveCaCert?.invoke(request.requestId, request.alias, request.certificate)
          } else {
            log("remove_ca_cert missing alias and certificate; ignoring")
          }
      is RequestGlobalAction -> onRequestGlobalAction?.invoke(request.requestId, request.action)
      is RequestDeviceInfo -> onRequestDeviceInfo?.invoke(request.requestId)
      is GetDeviceOwnerStatus -> onGetDeviceOwnerStatus?.invoke(request.requestId)
      is GetPermission ->
          onGetPermission?.invoke(request.requestId, request.permission, request.requestPermission)
      is SetRecompositionTracking -> onSetRecompositionTracking?.invoke(request.enabled)
      is SetAccessibilityFlags ->
          onSetAccessibilityFlags?.invoke(
              request.includeNotImportantViews,
              request.reportViewIds,
              request.retrieveInteractiveWindows,
          )
      is SetNetworkMockRules ->
          onSetNetworkMockRules?.invoke(
              json.encodeToString(ListSerializer(NetworkMockRuleDto.serializer()), request.rules)
          )
      is SetNetworkErrorSimulation ->
          onSetNetworkErrorSimulation?.invoke(
              request.enabled,
              request.errorType,
              request.limit,
              request.expiresAtEpochMs,
          )
      is GetCurrentFocus -> onGetCurrentFocus?.invoke(request.requestId)
      is GetTraversalOrder -> onGetTraversalOrder?.invoke(request.requestId)
      is AddHighlight ->
          onAddHighlight?.invoke(request.requestId, request.id, request.shape?.toModel())
      is ListPreferenceFiles ->
          onListPreferenceFiles?.invoke(request.requestId, request.packageName)
      is GetPreferences ->
          onGetPreferences?.invoke(request.requestId, request.packageName, request.fileName)
      is SubscribeStorage ->
          onSubscribeStorage?.invoke(request.requestId, request.packageName, request.fileName)
      is UnsubscribeStorage -> {
        val packageName = request.packageName
        val fileName = request.fileName
        if (packageName != null && fileName != null) {
          onUnsubscribeStorage?.invoke(request.requestId, packageName, fileName)
        } else {
          // Pre-existing behavior: the TS client sends only `subscriptionId`, so the device cannot
          // resolve packageName/fileName and the unsubscribe is a no-op. Tracked as a follow-up.
          log("unsubscribe_storage received subscriptionId=${request.subscriptionId} without packageName/fileName; ignoring")
        }
      }
      is GetPreference ->
          onGetPreference?.invoke(
              request.requestId,
              request.packageName,
              request.fileName,
              request.key,
          )
      is SetPreference ->
          onSetPreference?.invoke(
              request.requestId,
              request.packageName,
              request.fileName,
              request.key,
              request.value,
              request.valueType,
          )
      is RemovePreference ->
          onRemovePreference?.invoke(
              request.requestId,
              request.packageName,
              request.fileName,
              request.key,
          )
      is ClearPreferences ->
          onClearPreferences?.invoke(request.requestId, request.packageName, request.fileName)
      is StartRecording -> onStartRecording?.invoke()
      is StopRecording -> onStopRecording?.invoke()
      is RequestSettingsGet ->
          onRequestSettingsGet?.invoke(request.requestId, request.namespace, request.key)
      is RequestSettingsPut ->
          onRequestSettingsPut?.invoke(
              request.requestId,
              request.namespace,
              request.key,
              request.value,
              request.valueType,
          )
      is RequestSettingsList ->
          onRequestSettingsList?.invoke(request.requestId, request.namespace)
      is RequestInstalledPackages ->
          onRequestInstalledPackages?.invoke(
              request.requestId,
              request.includeSystem,
              request.userId,
          )
      is RequestPackageInfo ->
          onRequestPackageInfo?.invoke(
              request.requestId,
              request.packageName,
              request.includePermissions,
          )
      is RequestLaunchIntent ->
          onRequestLaunchIntent?.invoke(request.requestId, request.packageName)
    }

    // Every command above is fire-and-forget: the CtrlProxy action broadcasts its own response
    // asynchronously, so there is no synchronous response to return here.
    return null
  }
}
