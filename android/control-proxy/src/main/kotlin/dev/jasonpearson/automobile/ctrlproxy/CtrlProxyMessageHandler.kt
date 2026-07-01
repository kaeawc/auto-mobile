package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.AddHighlight
import dev.jasonpearson.automobile.protocol.ClearPreferences
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
import dev.jasonpearson.automobile.protocol.RequestClipboard
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
import dev.jasonpearson.automobile.protocol.RequestSetText
import dev.jasonpearson.automobile.protocol.RequestSettingsGet
import dev.jasonpearson.automobile.protocol.RequestSettingsList
import dev.jasonpearson.automobile.protocol.RequestSettingsPut
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
 * [CtrlProxyActions] method. This replaces the legacy flat-DTO + 43-case `when(type: String)`
 * decode path in [WebSocketServer]: the `when (request)` below is exhaustive over the sealed
 * hierarchy, so the compiler fails the build if a new request type is added without a branch here.
 *
 * The handler performs no Android I/O — it only decodes fields and calls [actions] — so it can be
 * unit-tested without Robolectric. Every current command is fire-and-forget (the action broadcasts
 * its own response asynchronously), so [handleMessage] always returns `null`.
 *
 * @param actions the device actions to dispatch to (the [CtrlProxy] service in production, a fake
 *   in tests).
 * @param log diagnostic sink for the few requests with no wired action (an ahead-of-need request
 *   type, or a malformed storage message the device can't resolve). Defaults to a no-op so tests
 *   stay Android-free; production wires it to `Log`.
 */
class CtrlProxyMessageHandler(
    private val actions: CtrlProxyActions,
    private val log: (String) -> Unit = {},
) : WebSocketMessageHandler {

  /** JSON used to re-encode the typed network mock rules into the string the SDK store expects. */
  private val json = Json { ignoreUnknownKeys = true }

  override suspend fun handleMessage(request: WebSocketRequest): WebSocketResponse? {
    // Exhaustive over the sealed hierarchy: adding a new WebSocketRequest subclass without a branch
    // here is a compile error, which is the whole point of retiring the string-typed `when`.
    when (request) {
      is RequestHierarchy -> actions.requestHierarchy(request.disableAllFiltering)
      is RequestHierarchyIfStale -> actions.requestHierarchyIfStale(request.sinceTimestamp)
      is RequestScreenshot -> actions.requestScreenshot(request.requestId)
      is RequestSwipe ->
          actions.requestSwipe(
              request.requestId,
              request.x1,
              request.y1,
              request.x2,
              request.y2,
              request.duration,
          )
      is RequestTapCoordinates ->
          actions.requestTapCoordinates(request.requestId, request.x, request.y, request.duration)
      is RequestTwoFingerSwipe ->
          actions.requestTwoFingerSwipe(
              request.requestId,
              request.x1,
              request.y1,
              request.x2,
              request.y2,
              request.duration,
              request.offset,
          )
      is RequestDrag ->
          actions.requestDrag(
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
          actions.requestPinch(
              request.requestId,
              request.centerX,
              request.centerY,
              request.distanceStart,
              request.distanceEnd,
              request.rotationDegrees,
              request.duration,
          )
      is RequestSetText ->
          actions.requestSetText(
              request.requestId,
              request.text,
              request.resourceId,
              request.dismissKeyboard,
          )
      is RequestImeAction -> actions.requestImeAction(request.requestId, request.action)
      is RequestSelectAll -> actions.requestSelectAll(request.requestId)
      is RequestAction ->
          actions.requestAction(request.requestId, request.action, request.resourceId)
      is RequestHitTest ->
          // Ahead-of-need: no TS client sends this and no device action is wired. Log loudly so a
          // future hit-test implementation notices the gap rather than silently dropping it.
          log(
              "request_hit_test received (requestId=${request.requestId}) but no device handler is wired; ignoring"
          )
      is RequestClipboard ->
          actions.requestClipboard(request.requestId, request.action, request.text)
      is InstallCaCert ->
          if (request.certificate.isNotBlank()) {
            actions.installCaCert(request.requestId, request.certificate)
          } else {
            log("install_ca_cert missing certificate; ignoring")
          }
      is InstallCaCertFromPath ->
          if (request.devicePath.isNotBlank()) {
            actions.installCaCertFromPath(request.requestId, request.devicePath)
          } else {
            log("install_ca_cert_from_path missing devicePath; ignoring")
          }
      is RemoveCaCert ->
          if (!request.alias.isNullOrBlank() || !request.certificate.isNullOrBlank()) {
            actions.removeCaCert(request.requestId, request.alias, request.certificate)
          } else {
            log("remove_ca_cert missing alias and certificate; ignoring")
          }
      is RequestGlobalAction -> actions.requestGlobalAction(request.requestId, request.action)
      is RequestDeviceInfo -> actions.requestDeviceInfo(request.requestId)
      is GetDeviceOwnerStatus -> actions.getDeviceOwnerStatus(request.requestId)
      is GetPermission ->
          actions.getPermission(request.requestId, request.permission, request.requestPermission)
      is SetRecompositionTracking -> actions.setRecompositionTracking(request.enabled)
      is SetAccessibilityFlags ->
          actions.setAccessibilityFlags(
              request.includeNotImportantViews,
              request.reportViewIds,
              request.retrieveInteractiveWindows,
          )
      is SetNetworkMockRules ->
          actions.setNetworkMockRules(
              json.encodeToString(ListSerializer(NetworkMockRuleDto.serializer()), request.rules)
          )
      is SetNetworkErrorSimulation ->
          actions.setNetworkErrorSimulation(
              request.enabled,
              request.errorType,
              request.limit,
              request.expiresAtEpochMs,
          )
      is GetCurrentFocus -> actions.getCurrentFocus(request.requestId)
      is GetTraversalOrder -> actions.getTraversalOrder(request.requestId)
      is AddHighlight ->
          actions.addHighlight(request.requestId, request.id, request.shape?.toModel())
      is ListPreferenceFiles -> actions.listPreferenceFiles(request.requestId, request.packageName)
      is GetPreferences ->
          actions.getPreferences(request.requestId, request.packageName, request.fileName)
      is SubscribeStorage ->
          actions.subscribeStorage(request.requestId, request.packageName, request.fileName)
      is UnsubscribeStorage -> {
        val packageName = request.packageName
        val fileName = request.fileName
        val subscriptionId = request.subscriptionId
        when {
          packageName != null && fileName != null ->
              actions.unsubscribeStorage(request.requestId, packageName, fileName)
          // Real TS traffic sends only `subscriptionId`, formatted as "packageName:fileName" by
          // StorageSubscriptionManager.subscribe(). Package names never contain ':', so split on
          // the
          // FIRST ':' to recover packageName/fileName (a file name could theoretically contain
          // ':').
          subscriptionId != null -> {
            val separator = subscriptionId.indexOf(':')
            if (separator > 0 && separator < subscriptionId.length - 1) {
              actions.unsubscribeStorage(
                  request.requestId,
                  subscriptionId.substring(0, separator),
                  subscriptionId.substring(separator + 1),
              )
            } else {
              log("unsubscribe_storage received malformed subscriptionId=$subscriptionId; ignoring")
            }
          }
          else ->
              log(
                  "unsubscribe_storage received without subscriptionId or packageName/fileName; ignoring"
              )
        }
      }
      is GetPreference ->
          actions.getPreference(
              request.requestId,
              request.packageName,
              request.fileName,
              request.key,
          )
      is SetPreference ->
          actions.setPreference(
              request.requestId,
              request.packageName,
              request.fileName,
              request.key,
              request.value,
              request.valueType,
          )
      is RemovePreference ->
          actions.removePreference(
              request.requestId,
              request.packageName,
              request.fileName,
              request.key,
          )
      is ClearPreferences ->
          actions.clearPreferences(request.requestId, request.packageName, request.fileName)
      is StartRecording -> actions.startRecording()
      is StopRecording -> actions.stopRecording()
      is RequestSettingsGet ->
          actions.requestSettingsGet(request.requestId, request.namespace, request.key)
      is RequestSettingsPut ->
          actions.requestSettingsPut(
              request.requestId,
              request.namespace,
              request.key,
              request.value,
              request.valueType,
          )
      is RequestSettingsList -> actions.requestSettingsList(request.requestId, request.namespace)
      is RequestInstalledPackages ->
          actions.requestInstalledPackages(
              request.requestId,
              request.includeSystem,
              request.userId,
          )
      is RequestPackageInfo ->
          actions.requestPackageInfo(
              request.requestId,
              request.packageName,
              request.includePermissions,
          )
      is RequestLaunchIntent -> actions.requestLaunchIntent(request.requestId, request.packageName)
    }

    // Every command above is fire-and-forget: the action broadcasts its own response
    // asynchronously, so there is no synchronous response to return here.
    return null
  }
}
