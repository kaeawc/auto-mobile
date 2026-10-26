package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.storage.StorageSubscription
import dev.jasonpearson.automobile.protocol.AddHighlight
import dev.jasonpearson.automobile.protocol.AdvancePrototypeClock
import dev.jasonpearson.automobile.protocol.ClearPreferences
import dev.jasonpearson.automobile.protocol.ClearPrototypeStorage
import dev.jasonpearson.automobile.protocol.DeleteSavedPrototype
import dev.jasonpearson.automobile.protocol.DiscoverKeystore
import dev.jasonpearson.automobile.protocol.DismissPrototype
import dev.jasonpearson.automobile.protocol.DragResult
import dev.jasonpearson.automobile.protocol.GetCurrentFocus
import dev.jasonpearson.automobile.protocol.GetDataStore
import dev.jasonpearson.automobile.protocol.GetDeviceOwnerStatus
import dev.jasonpearson.automobile.protocol.GetPermission
import dev.jasonpearson.automobile.protocol.GetPreference
import dev.jasonpearson.automobile.protocol.GetPreferences
import dev.jasonpearson.automobile.protocol.GetSdkCapabilities
import dev.jasonpearson.automobile.protocol.GetTraversalOrder
import dev.jasonpearson.automobile.protocol.InspectPrototypes
import dev.jasonpearson.automobile.protocol.InstallCaCert
import dev.jasonpearson.automobile.protocol.InstallCaCertFromPath
import dev.jasonpearson.automobile.protocol.ListDataStores
import dev.jasonpearson.automobile.protocol.ListPreferenceFiles
import dev.jasonpearson.automobile.protocol.ListSavedPrototypes
import dev.jasonpearson.automobile.protocol.NetworkMockRuleDto
import dev.jasonpearson.automobile.protocol.PatchPrototype
import dev.jasonpearson.automobile.protocol.PinSavedPrototype
import dev.jasonpearson.automobile.protocol.PinchResult
import dev.jasonpearson.automobile.protocol.PrototypeResult
import dev.jasonpearson.automobile.protocol.PutPrototypeAsset
import dev.jasonpearson.automobile.protocol.RemoveCaCert
import dev.jasonpearson.automobile.protocol.RemovePreference
import dev.jasonpearson.automobile.protocol.RemovePrototypeAsset
import dev.jasonpearson.automobile.protocol.RequestAction
import dev.jasonpearson.automobile.protocol.RequestActivateAccessibilityLink
import dev.jasonpearson.automobile.protocol.RequestCancelImeCommit
import dev.jasonpearson.automobile.protocol.RequestClickFocusedInput
import dev.jasonpearson.automobile.protocol.RequestClipboard
import dev.jasonpearson.automobile.protocol.RequestCommitText
import dev.jasonpearson.automobile.protocol.RequestDeviceInfo
import dev.jasonpearson.automobile.protocol.RequestDrag
import dev.jasonpearson.automobile.protocol.RequestGestureEnd
import dev.jasonpearson.automobile.protocol.RequestGestureMove
import dev.jasonpearson.automobile.protocol.RequestGestureStart
import dev.jasonpearson.automobile.protocol.RequestGlobalAction
import dev.jasonpearson.automobile.protocol.RequestHierarchy
import dev.jasonpearson.automobile.protocol.RequestHierarchyIfStale
import dev.jasonpearson.automobile.protocol.RequestHitTest
import dev.jasonpearson.automobile.protocol.RequestImeAction
import dev.jasonpearson.automobile.protocol.RequestInsertText
import dev.jasonpearson.automobile.protocol.RequestInsertTextState
import dev.jasonpearson.automobile.protocol.RequestInstalledPackages
import dev.jasonpearson.automobile.protocol.RequestLaunchIntent
import dev.jasonpearson.automobile.protocol.RequestListKeyboardProfiles
import dev.jasonpearson.automobile.protocol.RequestPackageInfo
import dev.jasonpearson.automobile.protocol.RequestPinch
import dev.jasonpearson.automobile.protocol.RequestScreenshot
import dev.jasonpearson.automobile.protocol.RequestSelectAll
import dev.jasonpearson.automobile.protocol.RequestSetKeyboardProfile
import dev.jasonpearson.automobile.protocol.RequestSetText
import dev.jasonpearson.automobile.protocol.RequestSettingsGet
import dev.jasonpearson.automobile.protocol.RequestSettingsList
import dev.jasonpearson.automobile.protocol.RequestSettingsPut
import dev.jasonpearson.automobile.protocol.RequestSwipe
import dev.jasonpearson.automobile.protocol.RequestTapCoordinates
import dev.jasonpearson.automobile.protocol.RequestTwoFingerSwipe
import dev.jasonpearson.automobile.protocol.SavePrototype
import dev.jasonpearson.automobile.protocol.SetAccessibilityFlags
import dev.jasonpearson.automobile.protocol.SetHierarchyInterval
import dev.jasonpearson.automobile.protocol.SetNetworkErrorSimulation
import dev.jasonpearson.automobile.protocol.SetNetworkMockRules
import dev.jasonpearson.automobile.protocol.SetPreference
import dev.jasonpearson.automobile.protocol.SetRecompositionTracking
import dev.jasonpearson.automobile.protocol.ShowPrototype
import dev.jasonpearson.automobile.protocol.StartRecording
import dev.jasonpearson.automobile.protocol.StopRecording
import dev.jasonpearson.automobile.protocol.SubscribeStorage
import dev.jasonpearson.automobile.protocol.SwipeResult
import dev.jasonpearson.automobile.protocol.TapCoordinatesResult
import dev.jasonpearson.automobile.protocol.UnsubscribeStorage
import dev.jasonpearson.automobile.protocol.ValidateFrameContext
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
 * unit-tested without Robolectric. The handler awaits each action; actions broadcast their own
 * responses, with existing service jobs retaining asynchronous completion, so [handleMessage]
 * normally returns `null`. Gesture display validation and the non-finite coordinate guard (see
 * [firstNonFinite]) instead return synchronous per-command error responses that [WebSocketServer]
 * broadcasts to the client — the Android analog of iOS `CommandHandler.requireFinite` (#2964,
 * mirror of #2928 / PR #2957).
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
  private val sdkInt: () -> Int = { android.os.Build.VERSION.SDK_INT },
) : WebSocketMessageHandler {

  /** JSON used to re-encode the typed network mock rules into the string the SDK store expects. */
  private val json = Json { ignoreUnknownKeys = true }

  override suspend fun handleMessage(request: WebSocketRequest): WebSocketResponse? {
    return when (RequestRoute(request).group) {
      RequestGroup.HIERARCHY -> handleHierarchy(request)
      RequestGroup.TEXT -> handleText(request)
      RequestGroup.NODE -> handleNode(request)
      RequestGroup.DEVICE -> handleDevice(request)
      RequestGroup.PROTOTYPE -> handlePrototype(request)
      RequestGroup.STORAGE -> StorageRequests().handleStorage(request)
      RequestGroup.SYSTEM -> handleSystem(request)
      RequestGroup.GESTURE -> GestureRequests().handleGesture(request)
    }
  }

  private suspend fun handleHierarchy(request: WebSocketRequest): WebSocketResponse? {
    when (request) {
      is RequestHierarchy -> actions.requestHierarchy(request)
      is RequestHierarchyIfStale ->
        actions.requestHierarchyIfStale(request.sinceTimestamp, request.requestId)
      is SetHierarchyInterval -> actions.setHierarchyInterval(request.intervalMs)
      is RequestScreenshot -> actions.requestScreenshot(request)
      else -> error("Unexpected hierarchy request")
    }
    return null
  }

  private suspend fun handleText(request: WebSocketRequest): WebSocketResponse? {
    when (request) {
      is RequestSetText -> actions.requestSetText(request)
      is RequestInsertTextState -> actions.requestInsertTextState(request.requestId)
      is RequestInsertText -> actions.requestInsertText(request)
      is RequestCommitText -> actions.requestCommitText(request)
      is RequestCancelImeCommit ->
        actions.requestCancelImeCommit(request.requestId, request.targetRequestId)
      is RequestSetKeyboardProfile ->
        actions.requestSetKeyboardProfile(request.requestId, request.profileId)
      is RequestListKeyboardProfiles ->
        actions.requestListKeyboardProfiles(request.requestId, request.supportedCatalogVersions)
      is RequestImeAction -> actions.requestImeAction(request)
      is RequestSelectAll -> actions.requestSelectAll(request.requestId)
      is RequestClickFocusedInput -> actions.requestClickFocusedInput(request.requestId)
      else -> error("Unexpected text request")
    }
    return null
  }

  private suspend fun handleNode(request: WebSocketRequest): WebSocketResponse? {
    when (request) {
      is RequestAction ->
        actions.requestAction(
          request.requestId,
          request.action,
          request.resourceId,
          request.selector,
          NodeActionArguments(customAction = request.customAction, progress = request.progress),
        )
      is RequestActivateAccessibilityLink ->
        actions.requestActivateAccessibilityLink(
          request.requestId,
          request.text,
          request.occurrence,
          request.selector,
        )
      is RequestHitTest ->
        // Ahead-of-need: no TS client sends this and no device action is wired. Log loudly so a
        // future hit-test implementation notices the gap rather than silently dropping it.
        log(
          "request_hit_test received (requestId=${request.requestId}) but no device handler is wired; ignoring",
        )
      is RequestClipboard ->
        actions.requestClipboard(request.requestId, request.action, request.text)
      is RequestGlobalAction -> actions.requestGlobalAction(request)
      is ValidateFrameContext ->
        actions.validateFrameContext(request.requestId, request.frameContext)
      is GetCurrentFocus -> actions.getCurrentFocus(request.requestId)
      is GetTraversalOrder -> actions.getTraversalOrder(request.requestId)
      is AddHighlight ->
        actions.addHighlight(request.requestId, request.id, request.shape?.toModel())

      else -> error("Unexpected node request")
    }
    return null
  }

  private suspend fun handleDevice(request: WebSocketRequest): WebSocketResponse? {
    when (request) {
      is InstallCaCert,
      is InstallCaCertFromPath,
      is RemoveCaCert -> handleCertificate(request)
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
          request.occlusionEnabled,
        )
      is SetNetworkMockRules ->
        actions.setNetworkMockRules(
          request.requestId,
          json.encodeToString(ListSerializer(NetworkMockRuleDto.serializer()), request.rules),
        )
      is SetNetworkErrorSimulation ->
        actions.setNetworkErrorSimulation(
          request.enabled,
          request.errorType,
          request.limit,
          request.expiresAtEpochMs,
          request.remainingMs,
        )
      else -> error("Unexpected device request")
    }
    return null
  }

  private suspend fun handleCertificate(request: WebSocketRequest) {
    when (request) {
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
      else -> error("Unexpected certificate request")
    }
  }

  private suspend fun handlePrototype(request: WebSocketRequest): WebSocketResponse? {
    when (request) {
      is ShowPrototype -> return handleShowPrototype(request)
      is DismissPrototype -> return handleDismissPrototype(request)
      is InspectPrototypes -> actions.inspectPrototypes(request.requestId)
      is SavePrototype ->
        actions.savePrototype(request.requestId, request.spec, request.label, request.icon)
      is PinSavedPrototype -> actions.pinSavedPrototype(request.requestId, request.id, request.icon)
      is ListSavedPrototypes -> actions.listSavedPrototypes(request.requestId)
      is DeleteSavedPrototype -> actions.deleteSavedPrototype(request.requestId, request.id)
      is AdvancePrototypeClock ->
        actions.advancePrototypeClock(request.requestId, request.id, request.advanceTimeMs)
      is ClearPrototypeStorage -> actions.clearPrototypeStorage(request.requestId, request.id)
      is PatchPrototype ->
        actions.patchPrototype(request.requestId, request.id, request.baseRevision, request.ops)
      is PutPrototypeAsset ->
        actions.putPrototypeAsset(
          request.requestId,
          request.id,
          request.mimeType,
          request.dataBase64,
        )
      is RemovePrototypeAsset -> actions.removePrototypeAsset(request.requestId, request.id)
      else -> error("Unexpected prototype request")
    }
    return null
  }

  private suspend fun handleShowPrototype(request: ShowPrototype): WebSocketResponse? {

    // Same display rules as the gestures; the controller then checks the display is connected.
    GestureDisplayRouting.error(request.displayId, sdkInt())?.let { error ->
      return PrototypeResult(
        timestamp = System.currentTimeMillis(),
        requestId = request.requestId,
        success = false,
        error = error,
      )
    }
    actions.showPrototype(
      request.requestId,
      request.spec,
      request.displayId,
      request.reset,
      request.appearance,
      request.replaceOthers,
    )

    return null
  }

  private suspend fun handleDismissPrototype(request: DismissPrototype): WebSocketResponse? {

    if ((request.id == null) == (request.all == null) || request.all == false) {
      return PrototypeResult(
        timestamp = System.currentTimeMillis(),
        requestId = request.requestId,
        success = false,
        error = "dismiss_prototype requires exactly one of id or all:true",
      )
    }
    actions.dismissPrototype(request.requestId, request.id, request.all)

    return null
  }

  private inner class StorageRequests {
    suspend fun handleStorage(request: WebSocketRequest): WebSocketResponse? {
      when (request) {
        is ListPreferenceFiles ->
          actions.listPreferenceFiles(request.requestId, request.packageName)
        is GetPreferences ->
          actions.getPreferences(request.requestId, request.packageName, request.fileName)
        is DiscoverKeystore -> actions.discoverKeystore(request.requestId, request.packageName)
        is GetSdkCapabilities ->
          actions.getSdkCapabilities(request.requestId, request.packageName, request.userId)
        is ListDataStores ->
          actions.listDataStores(request.requestId, request.packageName, request.adapterName)
        is GetDataStore ->
          actions.getDataStore(
            request.requestId,
            request.packageName,
            request.adapterName,
            request.storeName,
          )
        is SubscribeStorage ->
          actions.subscribeStorage(request.requestId, request.packageName, request.fileName)
        is UnsubscribeStorage -> unsubscribeStorage(request)
        is GetPreference,
        is SetPreference,
        is RemovePreference,
        is ClearPreferences -> handlePreference(request)
        else -> error("Unexpected storage request")
      }
      return null
    }

    private suspend fun handlePreference(request: WebSocketRequest) {
      when (request) {
        is GetPreference ->
          actions.getPreference(
            request.requestId,
            request.packageName,
            request.fileName,
            request.key,
          )
        is SetPreference -> actions.setPreference(request)
        is RemovePreference ->
          actions.removePreference(
            request.requestId,
            request.packageName,
            request.fileName,
            request.key,
          )
        is ClearPreferences ->
          actions.clearPreferences(request.requestId, request.packageName, request.fileName)
        else -> error("Unexpected preference request")
      }
    }

    private suspend fun unsubscribeStorage(request: UnsubscribeStorage) {

      val packageName = request.packageName
      val fileName = request.fileName
      val subscriptionId = request.subscriptionId
      when {
        packageName != null && fileName != null ->
          actions.unsubscribeStorage(request.requestId, packageName, fileName)
        // Real TS traffic sends only `subscriptionId` (formatted "packageName:fileName" by
        // StorageSubscriptionManager.subscribe()). StorageSubscription.parseId is the single
        // canonical inverse of that format — see its doc for the first-colon rationale.
        subscriptionId != null -> {
          val parts = StorageSubscription.parseId(subscriptionId)
          if (parts != null) {
            actions.unsubscribeStorage(request.requestId, parts.first, parts.second)
          } else {
            log("unsubscribe_storage received malformed subscriptionId=$subscriptionId; ignoring")
          }
        }
        else ->
          log(
            "unsubscribe_storage received without subscriptionId or packageName/fileName; ignoring",
          )
      }
    }
  }

  private suspend fun handleSystem(request: WebSocketRequest): WebSocketResponse? {
    when (request) {
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
      else -> error("Unexpected system request")
    }
    return null
  }

  private inner class GestureRequests {
    suspend fun handleGesture(request: WebSocketRequest): WebSocketResponse? =
      when (request) {
        is RequestSwipe -> handleSwipe(request)
        is RequestTapCoordinates -> handleTapCoordinates(request)
        is RequestTwoFingerSwipe -> handleTwoFingerSwipe(request)
        is RequestDrag -> handleDrag(request)
        is RequestPinch -> handlePinch(request)
        is RequestGestureStart -> handleGestureStart(request)
        is RequestGestureMove -> handleGestureMove(request)
        is RequestGestureEnd -> handleGestureEnd(request)
        else -> error("Unexpected gesture request")
      }

    private suspend fun handleSwipe(request: RequestSwipe): WebSocketResponse? {

      if (request.displayId != null) {
        GestureDisplayRouting.error(request.displayId, sdkInt())?.let { error ->
          return SwipeResult(
            timestamp = System.currentTimeMillis(),
            requestId = request.requestId,
            success = false,
            totalTimeMs = 0L,
            error = error,
          )
        }
      }
      firstNonFinite(
          "x1" to request.x1,
          "y1" to request.y1,
          "x2" to request.x2,
          "y2" to request.y2,
        )
        ?.let { (field, value) ->
          return swipeError(request.requestId, field, value)
        }
      actions.requestSwipe(request)

      return null
    }

    private suspend fun handleTapCoordinates(request: RequestTapCoordinates): WebSocketResponse? {

      if (request.displayId != null) {
        GestureDisplayRouting.error(request.displayId, sdkInt())?.let { error ->
          return TapCoordinatesResult(
            timestamp = System.currentTimeMillis(),
            requestId = request.requestId,
            success = false,
            totalTimeMs = 0L,
            error = error,
          )
        }
      }
      firstNonFinite("x" to request.x, "y" to request.y)?.let { (field, value) ->
        return TapCoordinatesResult(
          timestamp = System.currentTimeMillis(),
          requestId = request.requestId,
          success = false,
          totalTimeMs = 0L,
          error = nonFiniteError(field, value),
        )
      }
      if (request.doubleTap) {
        actions.requestDoubleTapCoordinates(
          request.requestId,
          request.x,
          request.y,
          request.frameContext,
          request.displayId,
        )
      } else {
        actions.requestTapCoordinates(request)
      }

      return null
    }

    private suspend fun handleTwoFingerSwipe(request: RequestTwoFingerSwipe): WebSocketResponse? {

      if (request.displayId != null) {
        GestureDisplayRouting.error(request.displayId, sdkInt())?.let { error ->
          return SwipeResult(
            timestamp = System.currentTimeMillis(),
            requestId = request.requestId,
            success = false,
            totalTimeMs = 0L,
            error = error,
          )
        }
      }
      multiFingerCountError(request.fingerCount)?.let { error ->
        return SwipeResult(
          timestamp = System.currentTimeMillis(),
          requestId = request.requestId,
          success = false,
          totalTimeMs = 0L,
          error = error,
        )
      }
      // Two-finger swipe shares the swipe_result response type. `offset` is an Int (a pixel gap),
      // so it cannot be non-finite and is not guarded.
      firstNonFinite(
          "x1" to request.x1,
          "y1" to request.y1,
          "x2" to request.x2,
          "y2" to request.y2,
        )
        ?.let { (field, value) ->
          return swipeError(request.requestId, field, value)
        }
      actions.requestTwoFingerSwipe(request)

      return null
    }

    private suspend fun handleDrag(request: RequestDrag): WebSocketResponse? {

      if (request.displayId != null) {
        GestureDisplayRouting.error(request.displayId, sdkInt())?.let { error ->
          return DragResult(
            timestamp = System.currentTimeMillis(),
            requestId = request.requestId,
            success = false,
            totalTimeMs = 0L,
            error = error,
          )
        }
      }
      firstNonFinite(
          "x1" to request.x1,
          "y1" to request.y1,
          "x2" to request.x2,
          "y2" to request.y2,
        )
        ?.let { (field, value) ->
          return DragResult(
            timestamp = System.currentTimeMillis(),
            requestId = request.requestId,
            success = false,
            totalTimeMs = 0L,
            error = nonFiniteError(field, value),
          )
        }
      actions.requestDrag(request)

      return null
    }

    private suspend fun handlePinch(request: RequestPinch): WebSocketResponse? {

      if (request.displayId != null) {
        GestureDisplayRouting.error(request.displayId, sdkInt())?.let { error ->
          return PinchResult(
            timestamp = System.currentTimeMillis(),
            requestId = request.requestId,
            success = false,
            totalTimeMs = 0L,
            error = error,
          )
        }
      }
      // `rotationDegrees` is a Float (not a coordinate) but still flows into the gesture-path
      // math, so a computed non-finite value is guarded too (AC #4 of #2964).
      firstNonFinite(
          "centerX" to request.centerX,
          "centerY" to request.centerY,
          "distanceStart" to request.distanceStart,
          "distanceEnd" to request.distanceEnd,
          "rotationDegrees" to request.rotationDegrees.toDouble(),
        )
        ?.let { (field, value) ->
          return PinchResult(
            timestamp = System.currentTimeMillis(),
            requestId = request.requestId,
            success = false,
            totalTimeMs = 0L,
            error = nonFiniteError(field, value),
          )
        }
      actions.requestPinch(request)

      return null
    }

    private suspend fun handleGestureStart(request: RequestGestureStart): WebSocketResponse? {

      if (request.displayId != null) {
        GestureDisplayRouting.error(request.displayId, sdkInt())?.let { error ->
          return SwipeResult(
            timestamp = System.currentTimeMillis(),
            requestId = request.requestId,
            success = false,
            totalTimeMs = 0L,
            error = error,
          )
        }
      }
      firstNonFinite("x" to request.x, "y" to request.y)?.let { (field, value) ->
        return swipeError(request.requestId, field, value)
      }
      actions.requestGestureStart(request)

      return null
    }

    private suspend fun handleGestureMove(request: RequestGestureMove): WebSocketResponse? {

      firstNonFinite("x" to request.x, "y" to request.y)?.let { (field, value) ->
        return swipeError(request.requestId, field, value)
      }
      actions.requestGestureMove(request.requestId, request.gestureId, request.x, request.y)

      return null
    }

    private suspend fun handleGestureEnd(request: RequestGestureEnd): WebSocketResponse? {

      firstNonFinite("x" to request.x, "y" to request.y)?.let { (field, value) ->
        return swipeError(request.requestId, field, value)
      }
      actions.requestGestureEnd(
        request.requestId,
        request.gestureId,
        request.x,
        request.y,
        request.cancel,
      )

      return null
    }
  }
}

/**
 * Reject a non-finite gesture coordinate (`NaN` / `±Infinity`) at the handler boundary before it
 * flows into the accessibility [android.accessibilityservice.GestureDescription] engine — the
 * Android analog of iOS `CommandHandler.requireFinite` (#2964, mirror of #2928 / PR #2957).
 *
 * A non-finite value cannot arrive over the wire: kotlinx.serialization's default config
 * (`allowSpecialFloatingPointValues = false`, used by [WebSocketServer.protocolJson]) rejects a
 * JSON overflow literal like `1e309` at decode ("Unexpected special floating-point value Infinity")
 * rather than coercing it into the widened `Double` field, and standard JSON has no
 * `NaN`/`Infinity` literal. So this is defense-in-depth for the non-wire construction path — an
 * in-process caller building a request from a computed `Double` (division, `hypot`, a normalized
 * offset) that yields a non-finite value — where it prevents a silent no-op / bogus gesture.
 *
 * @return the first non-finite `(field name, value)` among [fields], or null when all are finite.
 */
private fun firstNonFinite(vararg fields: Pair<String, Double>): Pair<String, Double>? =
  fields.firstOrNull {
    !it.second.isFinite()
  }

/** Actionable message for a rejected non-finite coordinate, naming the offending [field]. */
private fun nonFiniteError(field: String, value: Double): String =
  "Non-finite gesture coordinate: $field=$value. Coordinates must be finite (not NaN or Infinity)."

/** Build a `swipe_result` failure — shared by [RequestSwipe] and [RequestTwoFingerSwipe]. */
private fun swipeError(requestId: String?, field: String, value: Double): SwipeResult =
  SwipeResult(
    timestamp = System.currentTimeMillis(),
    requestId = requestId,
    success = false,
    totalTimeMs = 0L,
    error = nonFiniteError(field, value),
  )

private enum class RequestGroup {
  HIERARCHY,
  TEXT,
  NODE,
  DEVICE,
  PROTOTYPE,
  STORAGE,
  SYSTEM,
  GESTURE,
}

/** Exhaustive classification keeps additions to the sealed protocol visible to the compiler. */
private class RequestRoute(request: WebSocketRequest) {
  val group: RequestGroup =
    when (request) {
      is RequestHierarchy,
      is RequestHierarchyIfStale,
      is SetHierarchyInterval,
      is RequestScreenshot -> RequestGroup.HIERARCHY
      is RequestSetText,
      is RequestInsertTextState,
      is RequestInsertText,
      is RequestCommitText,
      is RequestCancelImeCommit,
      is RequestSetKeyboardProfile,
      is RequestListKeyboardProfiles,
      is RequestImeAction,
      is RequestSelectAll,
      is RequestClickFocusedInput -> RequestGroup.TEXT
      is RequestAction,
      is RequestActivateAccessibilityLink,
      is RequestHitTest,
      is RequestClipboard,
      is RequestGlobalAction,
      is ValidateFrameContext,
      is GetCurrentFocus,
      is GetTraversalOrder,
      is AddHighlight -> RequestGroup.NODE
      is InstallCaCert,
      is InstallCaCertFromPath,
      is RemoveCaCert,
      is RequestDeviceInfo,
      is GetDeviceOwnerStatus,
      is GetPermission,
      is SetRecompositionTracking,
      is SetAccessibilityFlags,
      is SetNetworkMockRules,
      is SetNetworkErrorSimulation -> RequestGroup.DEVICE
      is ShowPrototype,
      is DismissPrototype,
      is InspectPrototypes,
      is SavePrototype,
      is PinSavedPrototype,
      is ListSavedPrototypes,
      is DeleteSavedPrototype,
      is AdvancePrototypeClock,
      is ClearPrototypeStorage,
      is PatchPrototype,
      is PutPrototypeAsset,
      is RemovePrototypeAsset -> RequestGroup.PROTOTYPE
      is ListPreferenceFiles,
      is GetPreferences,
      is DiscoverKeystore,
      is GetSdkCapabilities,
      is ListDataStores,
      is GetDataStore,
      is SubscribeStorage,
      is UnsubscribeStorage,
      is GetPreference,
      is SetPreference,
      is RemovePreference,
      is ClearPreferences -> RequestGroup.STORAGE
      is StartRecording,
      is StopRecording,
      is RequestSettingsGet,
      is RequestSettingsPut,
      is RequestSettingsList,
      is RequestInstalledPackages,
      is RequestPackageInfo,
      is RequestLaunchIntent -> RequestGroup.SYSTEM
      is RequestSwipe,
      is RequestTapCoordinates,
      is RequestTwoFingerSwipe,
      is RequestDrag,
      is RequestPinch,
      is RequestGestureStart,
      is RequestGestureMove,
      is RequestGestureEnd -> RequestGroup.GESTURE
    }
}
