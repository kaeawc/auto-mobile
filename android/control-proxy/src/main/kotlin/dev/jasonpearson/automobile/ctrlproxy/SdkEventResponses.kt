package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.AnrData
import dev.jasonpearson.automobile.protocol.AnrEvent
import dev.jasonpearson.automobile.protocol.BroadcastEventData
import dev.jasonpearson.automobile.protocol.BroadcastEventResponse
import dev.jasonpearson.automobile.protocol.DeviceInfo
import dev.jasonpearson.automobile.protocol.LifecycleEventData
import dev.jasonpearson.automobile.protocol.LifecycleEventResponse
import dev.jasonpearson.automobile.protocol.NetworkEventData
import dev.jasonpearson.automobile.protocol.NetworkEventResponse
import dev.jasonpearson.automobile.protocol.SdkAnrEvent
import dev.jasonpearson.automobile.protocol.SdkBroadcastEvent
import dev.jasonpearson.automobile.protocol.SdkCrashEvent
import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkHandledExceptionEvent
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.protocol.SdkLogEvent
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import dev.jasonpearson.automobile.protocol.SdkNotificationActionEvent
import dev.jasonpearson.automobile.protocol.SdkRecompositionSnapshotEvent
import dev.jasonpearson.automobile.protocol.SdkWebSocketFrameEvent
import dev.jasonpearson.automobile.protocol.WebSocketFrameData
import dev.jasonpearson.automobile.protocol.WebSocketFrameResponse
import dev.jasonpearson.automobile.protocol.WebSocketResponse

/** Convert SDK telemetry to its client response without performing I/O. */
internal fun sdkEventResponse(event: SdkEvent): WebSocketResponse? =
  when (event) {
    is SdkNetworkRequestEvent -> networkEventResponse(event)
    is SdkWebSocketFrameEvent -> webSocketFrameResponse(event)
    // SdkLogEvent no longer broadcast from SDK — logs captured via logcat reader
    is SdkLogEvent -> null
    is SdkBroadcastEvent -> broadcastEventResponse(event)
    is SdkLifecycleEvent -> lifecycleEventResponse(event)
    is SdkAnrEvent -> anrEventResponse(event)
    // Existing event types handled by their own receivers — skip here
    is SdkNavigationEvent,
    is SdkHandledExceptionEvent,
    is SdkCrashEvent,
    is SdkNotificationActionEvent,
    is SdkRecompositionSnapshotEvent,
    is SdkEventBatch -> null
  }

private fun networkEventResponse(event: SdkNetworkRequestEvent): NetworkEventResponse =
  NetworkEventResponse(
    timestamp = event.timestamp,
    event =
      NetworkEventData(
        url = event.url,
        method = event.method,
        statusCode = event.statusCode,
        durationMs = event.durationMs,
        requestBodySize = event.requestBodySize,
        responseBodySize = event.responseBodySize,
        protocol = event.protocol,
        host = event.host,
        path = event.path,
        error = event.error,
        applicationId = event.applicationId,
        requestHeaders = event.requestHeaders,
        responseHeaders = event.responseHeaders,
        requestBody = event.requestBody,
        responseBody = event.responseBody,
        contentType = event.contentType,
      ),
  )

private fun webSocketFrameResponse(event: SdkWebSocketFrameEvent): WebSocketFrameResponse =
  WebSocketFrameResponse(
    timestamp = event.timestamp,
    event =
      WebSocketFrameData(
        connectionId = event.connectionId,
        url = event.url,
        direction = event.direction.name.lowercase(),
        frameType = event.frameType.name.lowercase(),
        payloadSize = event.payloadSize,
        success = event.success,
        applicationId = event.applicationId,
      ),
  )

private fun broadcastEventResponse(event: SdkBroadcastEvent): BroadcastEventResponse =
  BroadcastEventResponse(
    timestamp = event.timestamp,
    event =
      BroadcastEventData(
        action = event.action,
        categories = event.categories,
        extraKeys = event.extraKeys,
        applicationId = event.applicationId,
      ),
  )

private fun lifecycleEventResponse(event: SdkLifecycleEvent): LifecycleEventResponse =
  LifecycleEventResponse(
    timestamp = event.timestamp,
    event =
      LifecycleEventData(
        kind = event.kind,
        details = event.details,
        applicationId = event.applicationId,
      ),
  )

private fun anrEventResponse(event: SdkAnrEvent): AnrEvent =
  AnrEvent(
    timestamp = event.timestamp,
    event =
      AnrData(
        pid = event.pid,
        processName = event.processName,
        importance = event.importance,
        trace = event.trace,
        reason = event.reason,
        packageName = event.applicationId ?: "unknown",
        appVersion = event.appVersion,
        deviceInfo =
          DeviceInfo(
            model = event.deviceInfo?.model ?: "unknown",
            manufacturer = event.deviceInfo?.manufacturer ?: "unknown",
            osVersion = event.deviceInfo?.osVersion ?: "unknown",
            sdkInt = event.deviceInfo?.sdkInt ?: 0,
          ),
      ),
  )
