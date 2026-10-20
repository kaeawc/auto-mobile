package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.domain.CoordinateSpace
import dev.jasonpearson.automobile.desktop.domain.KeyValueType
import kotlinx.coroutines.flow.update

internal suspend fun ObservationStreamClient.handleHierarchyUpdate(response: StreamResponse) {

  // Extract packageName from the data if present
  val packageName = extractPackageName(response.data)
  log.info(
    "Hierarchy update received - deviceId=${response.deviceId}, timestamp=${response.timestamp}, packageName=$packageName, dataPresent=${response.data != null}",
  )
  val update =
    HierarchyStreamUpdate(
      deviceId = response.deviceId,
      timestamp = response.timestamp ?: System.currentTimeMillis(),
      data = response.data,
      packageName = packageName,
      diff = response.hierarchyDiff,
      captureSequence = response.captureSequence,
      frameContext = response.frameContext,
      coordinateSpace = CoordinateSpace.fromWire(response.coordinateSpace),
      nativeScale = response.nativeScale,
      rotation = response.rotation,
    )
  _hierarchyUpdates.emit(update)
  log.info("Emitted hierarchy update to flow")
}

internal suspend fun ObservationStreamClient.handleScreenshotUpdate(response: StreamResponse) {

  log.info(
    "Screenshot update received - deviceId=${response.deviceId}, hasScreenshot=${response.screenshotBase64 != null}",
  )
  val update =
    ScreenshotStreamUpdate(
      deviceId = response.deviceId,
      timestamp = response.timestamp ?: System.currentTimeMillis(),
      screenshotBase64 = response.screenshotBase64,
      screenWidth = response.screenWidth ?: 1080,
      screenHeight = response.screenHeight ?: 2340,
      screenshotMimeType = response.screenshotMimeType,
      screenshotFormat = response.screenshotFormat,
      screenshotCaptureSource = response.screenshotCaptureSource,
      screenshotFallback = response.screenshotFallback,
      screenshotFallbackReason = response.screenshotFallbackReason,
      screenshotCaptureDurationMs = response.screenshotCaptureDurationMs,
      screenshotEncodeDurationMs = response.screenshotEncodeDurationMs,
      screenshotByteLength = response.screenshotByteLength,
      screenshotBase64Length = response.screenshotBase64Length,
      captureSequence = response.captureSequence,
      frameContext = response.frameContext,
      coordinateSpace = CoordinateSpace.fromWire(response.coordinateSpace),
      nativeScale = response.nativeScale,
      rotation = response.rotation,
    )
  _screenshotUpdates.emit(update)
  log.info("Emitted screenshot update to flow")
}

internal suspend fun ObservationStreamClient.handleNavigationUpdate(response: StreamResponse) {

  val navGraph = response.navigationGraph
  log.info(
    "Navigation update received - appId=${navGraph?.appId}, nodes=${navGraph?.nodes?.size}, edges=${navGraph?.edges?.size}",
  )
  if (navGraph != null) {
    val update =
      NavigationGraphStreamUpdate(
        timestamp = response.timestamp ?: System.currentTimeMillis(),
        appId = navGraph.appId,
        nodes = navGraph.nodes,
        edges = navGraph.edges,
        currentScreen = navGraph.currentScreen,
      )
    _navigationUpdates.emit(update)
    log.info("Emitted navigation update to flow")
  }
}

internal fun ObservationStreamClient.handlePerformanceUpdate(response: StreamResponse) {

  val perfData = response.performanceData
  log.info(
    "Performance update received - deviceId=${response.deviceId}, fps=${perfData?.fps}, jankFrames=${perfData?.jankFrames}, touchLatencyMs=${perfData?.touchLatencyMs}, ttiMs=${perfData?.timeToInteractiveMs}",
  )
  if (perfData != null) {
    // When jank is 0 and FPS is below 60, the device is idle (no frames
    // being rendered). The reported FPS gets stuck at a stale value.
    // Assume 60 FPS / 16.67ms frame time since nothing is janking.
    val isIdle = perfData.jankFrames == 0 && perfData.fps < 60f
    val fps = if (isIdle) 60f else perfData.fps
    val frameTimeMs = if (isIdle) 16.67f else perfData.frameTimeMs
    val update =
      PerformanceStreamUpdate(
        deviceId = response.deviceId,
        timestamp = response.timestamp ?: System.currentTimeMillis(),
        fps = fps,
        frameTimeMs = frameTimeMs,
        jankFrames = perfData.jankFrames,
        droppedFrames = perfData.droppedFrames,
        memoryUsageMb = perfData.memoryUsageMb,
        cpuUsagePercent = perfData.cpuUsagePercent,
        touchLatencyMs = perfData.touchLatencyMs,
        timeToInteractiveMs = perfData.timeToInteractiveMs,
        screenName = perfData.screenName,
        isResponsive = perfData.isResponsive,
        recompositionCount = perfData.recompositionCount,
        recompositionRate = perfData.recompositionRate,
      )
    _performanceUpdates.tryEmit(update)
    log.info("Emitted performance update to flow")
  }
}

internal fun ObservationStreamClient.handleStorageUpdate(response: StreamResponse) {

  val storageEvent = response.storageEvent
  if (storageEvent == null) {
    log.warn("storage_update without a storageEvent payload, ignoring")
  } else {
    val update =
      StorageStreamUpdate(
        deviceId = response.deviceId,
        // The frame's own timestamp is the daemon's receive clock; the event carries the
        // device-side time the change actually happened, which is what ordering wants.
        timestamp = storageEvent.timestamp,
        packageName = storageEvent.packageName,
        fileName = storageEvent.fileName,
        key = storageEvent.key,
        value = storageEvent.value,
        valueType = KeyValueType.fromProtocolName(storageEvent.valueType),
        sequenceNumber = storageEvent.sequenceNumber,
      )
    if (!enqueueStorageUpdate(update)) {
      log.warn("Storage update channel closed before update delivery")
    }
  }
}

internal suspend fun ObservationStreamClient.handleDeviceBuildContext(response: StreamResponse) {

  val deviceId = response.deviceId
  val packageId = response.packageId
  if (deviceId.isNullOrBlank() || packageId.isNullOrBlank()) {
    log.warn("device_build_context without deviceId/packageId, ignoring")
  } else {
    _buildContextUpdates.emit(
      BuildContextStreamUpdate(
        deviceId = deviceId,
        deviceSessionUuid = response.deviceSessionUuid,
        timestamp = response.timestamp ?: System.currentTimeMillis(),
        packageId = packageId,
        buildKey = response.buildKey,
      ),
    )
  }
}

internal suspend fun ObservationStreamClient.handleDataMessage(response: StreamResponse): Boolean {
  when (response.type) {
    "hierarchy_update" -> handleHierarchyUpdate(response)
    "screenshot_update" -> handleScreenshotUpdate(response)
    "navigation_update" -> handleNavigationUpdate(response)
    "performance_update" -> handlePerformanceUpdate(response)
    "storage_update" -> handleStorageUpdate(response)
    "device_build_context" -> handleDeviceBuildContext(response)
    else -> return false
  }
  return true
}
