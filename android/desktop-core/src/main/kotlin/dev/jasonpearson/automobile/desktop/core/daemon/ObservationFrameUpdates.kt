package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.domain.CoordinateSpace
import dev.jasonpearson.automobile.desktop.domain.KeyValueType
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

// Pure conversions from observation-stream frames to the updates the flows carry, shared by the
// per-device client and the multiplexer.

/**
 * The `packageName` of a hierarchy frame's data, shaped `{ "hierarchy": {...}, "packageName": ...
 * }`, when present and non-empty.
 */
internal fun extractHierarchyPackageName(data: JsonElement?): String? {
  val obj = data as? JsonObject ?: return null
  val packageNameElement = obj["packageName"] as? JsonPrimitive
  return packageNameElement?.contentOrNull?.takeIf { it.isNotEmpty() }
}

internal fun StreamResponse.toHierarchyUpdate(): HierarchyStreamUpdate =
  HierarchyStreamUpdate(
    deviceId = deviceId,
    timestamp = timestamp ?: System.currentTimeMillis(),
    data = data,
    packageName = extractHierarchyPackageName(data),
    diff = hierarchyDiff,
    captureSequence = captureSequence,
    frameContext = frameContext,
    coordinateSpace = CoordinateSpace.fromWire(coordinateSpace),
    nativeScale = nativeScale,
    rotation = rotation,
  )

internal fun StreamResponse.toScreenshotUpdate(): ScreenshotStreamUpdate =
  ScreenshotStreamUpdate(
    deviceId = deviceId,
    timestamp = timestamp ?: System.currentTimeMillis(),
    screenshotBase64 = screenshotBase64,
    screenWidth = screenWidth ?: 1080,
    screenHeight = screenHeight ?: 2340,
    screenshotMimeType = screenshotMimeType,
    screenshotFormat = screenshotFormat,
    screenshotCaptureSource = screenshotCaptureSource,
    screenshotFallback = screenshotFallback,
    screenshotFallbackReason = screenshotFallbackReason,
    screenshotCaptureDurationMs = screenshotCaptureDurationMs,
    screenshotEncodeDurationMs = screenshotEncodeDurationMs,
    screenshotByteLength = screenshotByteLength,
    screenshotBase64Length = screenshotBase64Length,
    captureSequence = captureSequence,
    frameContext = frameContext,
    coordinateSpace = CoordinateSpace.fromWire(coordinateSpace),
    nativeScale = nativeScale,
    rotation = rotation,
  )

/** Null when the frame carries no graph. */
internal fun StreamResponse.toNavigationUpdate(): NavigationGraphStreamUpdate? {
  val navGraph = navigationGraph ?: return null
  return NavigationGraphStreamUpdate(
    timestamp = timestamp ?: System.currentTimeMillis(),
    appId = navGraph.appId,
    nodes = navGraph.nodes,
    edges = navGraph.edges,
    currentScreen = navGraph.currentScreen,
  )
}

/** Null when the frame carries no metrics. */
internal fun StreamResponse.toPerformanceUpdate(): PerformanceStreamUpdate? {
  val perfData = performanceData ?: return null
  // When jank is 0 and FPS is below 60, the device is idle (no frames being rendered). The
  // reported FPS gets stuck at a stale value. Assume 60 FPS / 16.67ms frame time since nothing is
  // janking.
  val isIdle = perfData.jankFrames == 0 && perfData.fps < 60f
  return PerformanceStreamUpdate(
    deviceId = deviceId,
    timestamp = timestamp ?: System.currentTimeMillis(),
    fps = if (isIdle) 60f else perfData.fps,
    frameTimeMs = if (isIdle) 16.67f else perfData.frameTimeMs,
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
}

/** Null when the frame carries no storage event. */
internal fun StreamResponse.toStorageUpdate(): StorageStreamUpdate? {
  val storageEvent = storageEvent ?: return null
  return StorageStreamUpdate(
    deviceId = deviceId,
    // The frame's own timestamp is the daemon's receive clock; the event carries the device-side
    // time the change actually happened, which is what ordering wants.
    timestamp = storageEvent.timestamp,
    packageName = storageEvent.packageName,
    fileName = storageEvent.fileName,
    key = storageEvent.key,
    value = storageEvent.value,
    valueType = KeyValueType.fromProtocolName(storageEvent.valueType),
    sequenceNumber = storageEvent.sequenceNumber,
  )
}

/** Null when the frame lacks the device or package it describes. */
internal fun StreamResponse.toBuildContextUpdate(): BuildContextStreamUpdate? {
  val deviceId = deviceId
  val packageId = packageId
  if (deviceId.isNullOrBlank() || packageId.isNullOrBlank()) return null
  return BuildContextStreamUpdate(
    deviceId = deviceId,
    deviceSessionUuid = deviceSessionUuid,
    timestamp = timestamp ?: System.currentTimeMillis(),
    packageId = packageId,
    buildKey = buildKey,
  )
}

/** A `device_session_ended` frame's successor epoch; null when any identity is missing. */
internal fun StreamResponse.toSessionSuperseded(): DeviceStreamEvent.DeviceSessionSuperseded? {
  val deviceId = deviceId
  val retiredUuid = deviceSessionUuid
  val successorUuid = successorSessionUuid
  if (deviceId.isNullOrBlank() || retiredUuid.isNullOrBlank() || successorUuid.isNullOrBlank()) {
    return null
  }
  return DeviceStreamEvent.DeviceSessionSuperseded(
    deviceId = deviceId,
    retiredUuid = retiredUuid,
    successorUuid = successorUuid,
    timestamp = timestamp ?: System.currentTimeMillis(),
  )
}

/** A `device connection lost` error frame as an event; null for any other error. */
internal fun StreamResponse.toConnectionLost(): DeviceStreamEvent.DeviceConnectionLost? {
  val deviceId = deviceId ?: return null
  val error = error ?: return null
  if (error != DEVICE_CONNECTION_LOST_ERROR) return null
  return DeviceStreamEvent.DeviceConnectionLost(
    deviceId = deviceId,
    timestamp = timestamp ?: System.currentTimeMillis(),
    error = error,
  )
}
