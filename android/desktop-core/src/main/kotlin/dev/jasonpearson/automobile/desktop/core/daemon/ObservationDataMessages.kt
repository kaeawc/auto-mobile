package dev.jasonpearson.automobile.desktop.core.daemon

internal suspend fun ObservationStreamClient.handleHierarchyUpdate(response: StreamResponse) {
  val update = response.toHierarchyUpdate()
  log.info(
    "Hierarchy update received - deviceId=${response.deviceId}, timestamp=${response.timestamp}, packageName=${update.packageName}, dataPresent=${response.data != null}",
  )
  _hierarchyUpdates.emit(update)
}

internal suspend fun ObservationStreamClient.handleScreenshotUpdate(response: StreamResponse) {
  log.info(
    "Screenshot update received - deviceId=${response.deviceId}, hasScreenshot=${response.screenshotBase64 != null}",
  )
  _screenshotUpdates.emit(response.toScreenshotUpdate())
}

internal suspend fun ObservationStreamClient.handleNavigationUpdate(response: StreamResponse) {
  val navGraph = response.navigationGraph
  log.info(
    "Navigation update received - appId=${navGraph?.appId}, nodes=${navGraph?.nodes?.size}, edges=${navGraph?.edges?.size}",
  )
  response.toNavigationUpdate()?.let { _navigationUpdates.emit(it) }
}

internal fun ObservationStreamClient.handlePerformanceUpdate(response: StreamResponse) {
  val perfData = response.performanceData
  log.info(
    "Performance update received - deviceId=${response.deviceId}, fps=${perfData?.fps}, jankFrames=${perfData?.jankFrames}, touchLatencyMs=${perfData?.touchLatencyMs}, ttiMs=${perfData?.timeToInteractiveMs}",
  )
  response.toPerformanceUpdate()?.let { _performanceUpdates.tryEmit(it) }
}

internal fun ObservationStreamClient.handleStorageUpdate(response: StreamResponse) {
  val update = response.toStorageUpdate()
  if (update == null) {
    log.warn("storage_update without a storageEvent payload, ignoring")
  } else if (!enqueueStorageUpdate(update)) {
    log.warn("Storage update channel closed before update delivery")
  }
}

internal suspend fun ObservationStreamClient.handleDeviceBuildContext(response: StreamResponse) {
  val update = response.toBuildContextUpdate()
  if (update == null) {
    log.warn("device_build_context without deviceId/packageId, ignoring")
  } else {
    _buildContextUpdates.emit(update)
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
