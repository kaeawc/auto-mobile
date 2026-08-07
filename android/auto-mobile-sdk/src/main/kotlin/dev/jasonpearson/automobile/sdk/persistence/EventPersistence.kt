package dev.jasonpearson.automobile.sdk.persistence

import dev.jasonpearson.automobile.protocol.NavigationSourceType
import dev.jasonpearson.automobile.protocol.SdkAnrEvent
import dev.jasonpearson.automobile.protocol.SdkBroadcastEvent
import dev.jasonpearson.automobile.protocol.SdkCrashEvent
import dev.jasonpearson.automobile.protocol.SdkDeviceInfo
import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkHandledExceptionEvent
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.protocol.SdkLogEvent
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import dev.jasonpearson.automobile.protocol.SdkNotificationActionEvent
import dev.jasonpearson.automobile.protocol.SdkRecompositionSnapshotEvent
import dev.jasonpearson.automobile.protocol.SdkWebSocketFrameEvent
import dev.jasonpearson.automobile.protocol.WebSocketFrameDirection
import dev.jasonpearson.automobile.protocol.WebSocketFrameType
import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/**
 * Persistence layer for SDK events. Persists event batches to disk so they survive process death
 * and can be replayed on next launch.
 */
internal interface EventPersistence {
  /** Persist a batch of events to disk. Returns batch ID on success, null on failure. */
  fun persist(events: List<SdkEvent>): String?

  /** Load all pending batches from disk, ordered oldest-first (FIFO). */
  fun loadPending(): List<Pair<String, List<SdkEvent>>>

  /** Remove a successfully delivered batch by ID. */
  fun removeBatch(batchId: String)

  /** Remove batches older than [maxAgeDays]. */
  fun cleanup(maxAgeDays: Int = 7)
}

/**
 * File-based event persistence. One JSON file per batch. Files named:
 * events_{timestamp}_{uuid}.json for FIFO ordering.
 */
internal class FileEventPersistence(
  private val directory: File,
  private val clock: () -> Long = System::currentTimeMillis,
  private val uuidProvider: () -> String = { UUID.randomUUID().toString() },
) : EventPersistence {

  init {
    directory.mkdirs()
  }

  override fun persist(events: List<SdkEvent>): String? {
    if (events.isEmpty()) return null
    val batchId = "${clock()}_${uuidProvider()}"
    val file = File(directory, "events_$batchId.json")
    return try {
      file.writeText(serializeEvents(events))
      batchId
    } catch (_: Exception) {
      null
    }
  }

  override fun loadPending(): List<Pair<String, List<SdkEvent>>> {
    val files =
      directory.listFiles { f ->
        f.name.startsWith("events_") && f.name.endsWith(".json")
      } ?: return emptyList()

    return files
      .sortedBy { it.name }
      .mapNotNull { file ->
        try {
          val events = deserializeEvents(file.readText())
          val batchId = file.name.removePrefix("events_").removeSuffix(".json")
          batchId to events
        } catch (_: Exception) {
          file.delete() // corrupt file, remove it
          null
        }
      }
  }

  override fun removeBatch(batchId: String) {
    File(directory, "events_$batchId.json").delete()
  }

  override fun cleanup(maxAgeDays: Int) {
    val cutoff = clock() - (maxAgeDays * 24 * 60 * 60 * 1000L)
    directory
      .listFiles { f -> f.name.startsWith("events_") }
      ?.forEach { file ->
        val timestamp = file.name.removePrefix("events_").substringBefore("_").toLongOrNull()
        if (timestamp != null && timestamp < cutoff) {
          file.delete()
        }
      }
  }

  internal fun serializeEvents(events: List<SdkEvent>): String {
    val array = JSONArray()
    for (event in events) {
      val obj = JSONObject()
      obj.put("type", eventTypeKey(event))
      obj.put("timestamp", event.timestamp)
      obj.put("applicationId", event.applicationId ?: "")
      when (event) {
        is SdkNavigationEvent -> {
          obj.put("destination", event.destination)
          obj.put("source", event.source.name)
          event.arguments?.let { obj.put("arguments", JSONObject(it)) }
          event.metadata?.let { obj.put("metadata", JSONObject(it)) }
        }
        is SdkHandledExceptionEvent -> {
          obj.put("exceptionClass", event.exceptionClass)
          obj.put("exceptionMessage", event.exceptionMessage ?: "")
          obj.put("stackTrace", event.stackTrace)
          event.customMessage?.let { obj.put("customMessage", it) }
          event.currentScreen?.let { obj.put("currentScreen", it) }
          event.appVersion?.let { obj.put("appVersion", it) }
          event.deviceInfo?.let { obj.put("deviceInfo", serializeDeviceInfo(it)) }
        }
        is SdkNotificationActionEvent -> {
          obj.put("notificationId", event.notificationId)
          obj.put("actionId", event.actionId)
          obj.put("actionLabel", event.actionLabel)
        }
        is SdkRecompositionSnapshotEvent -> {
          obj.put("snapshotJson", event.snapshotJson)
        }
        is SdkCrashEvent -> {
          obj.put("exceptionClass", event.exceptionClass)
          obj.put("exceptionMessage", event.exceptionMessage ?: "")
          obj.put("stackTrace", event.stackTrace)
          obj.put("threadName", event.threadName)
          event.currentScreen?.let { obj.put("currentScreen", it) }
          event.appVersion?.let { obj.put("appVersion", it) }
          event.deviceInfo?.let { obj.put("deviceInfo", serializeDeviceInfo(it)) }
        }
        is SdkAnrEvent -> {
          obj.put("pid", event.pid)
          obj.put("processName", event.processName)
          obj.put("importance", event.importance)
          event.trace?.let { obj.put("trace", it) }
          obj.put("reason", event.reason)
          event.appVersion?.let { obj.put("appVersion", it) }
          event.deviceInfo?.let { obj.put("deviceInfo", serializeDeviceInfo(it)) }
        }
        is SdkNetworkRequestEvent -> {
          obj.put("url", event.url)
          obj.put("method", event.method)
          obj.put("statusCode", event.statusCode)
          obj.put("durationMs", event.durationMs)
          obj.put("requestBodySize", event.requestBodySize)
          obj.put("responseBodySize", event.responseBodySize)
          event.protocol?.let { obj.put("protocol", it) }
          event.host?.let { obj.put("host", it) }
          event.path?.let { obj.put("path", it) }
          event.error?.let { obj.put("error", it) }
          event.requestHeaders?.let { obj.put("requestHeaders", JSONObject(it)) }
          event.responseHeaders?.let { obj.put("responseHeaders", JSONObject(it)) }
          event.requestBody?.let { obj.put("requestBody", it) }
          event.responseBody?.let { obj.put("responseBody", it) }
          event.contentType?.let { obj.put("contentType", it) }
        }
        is SdkWebSocketFrameEvent -> {
          obj.put("connectionId", event.connectionId)
          obj.put("url", event.url)
          obj.put("direction", event.direction.name)
          obj.put("frameType", event.frameType.name)
          obj.put("payloadSize", event.payloadSize)
          obj.put("success", event.success)
        }
        is SdkLogEvent -> {
          obj.put("level", event.level)
          obj.put("tag", event.tag)
          obj.put("message", event.message)
          obj.put("pid", event.pid)
          obj.put("tid", event.tid)
        }
        is SdkBroadcastEvent -> {
          obj.put("action", event.action)
          event.categories?.let { obj.put("categories", JSONArray(it)) }
          event.extraKeys?.let { obj.put("extraKeys", JSONObject(it)) }
        }
        is SdkLifecycleEvent -> {
          obj.put("kind", event.kind)
          event.details?.let { obj.put("details", JSONObject(it)) }
        }
        else -> obj.put("data", event.toString())
      }
      array.put(obj)
    }
    return array.toString()
  }

  private fun eventTypeKey(event: SdkEvent): String =
    when (event) {
      is SdkNavigationEvent -> "navigation"
      is SdkHandledExceptionEvent -> "handled_exception"
      is SdkNotificationActionEvent -> "notification_action"
      is SdkRecompositionSnapshotEvent -> "recomposition_snapshot"
      is SdkCrashEvent -> "crash"
      is SdkAnrEvent -> "anr"
      is SdkNetworkRequestEvent -> "network_request"
      is SdkWebSocketFrameEvent -> "websocket_frame"
      is SdkLogEvent -> "log"
      is SdkBroadcastEvent -> "broadcast"
      is SdkLifecycleEvent -> "lifecycle"
      else -> "unknown"
    }

  private fun serializeDeviceInfo(info: SdkDeviceInfo): JSONObject {
    val obj = JSONObject()
    obj.put("model", info.model)
    obj.put("manufacturer", info.manufacturer)
    obj.put("osVersion", info.osVersion)
    obj.put("sdkInt", info.sdkInt)
    return obj
  }

  internal fun deserializeEvents(json: String): List<SdkEvent> {
    val array = JSONArray(json)
    return (0 until array.length()).mapNotNull { i ->
      val obj = array.getJSONObject(i)
      deserializeEvent(
        type = obj.optString("type"),
        obj = obj,
        timestamp = obj.optLong("timestamp"),
        appId = obj.optString("applicationId").ifEmpty { null },
      )
    }
  }

  @Suppress("CyclomaticComplexMethod")
  private fun deserializeEvent(
    type: String,
    obj: JSONObject,
    timestamp: Long,
    appId: String?,
  ): SdkEvent? =
    when (type) {
      "navigation" -> {
        val sourceName = obj.optString("source")
        val source =
          try {
            NavigationSourceType.valueOf(sourceName)
          } catch (_: Exception) {
            NavigationSourceType.CUSTOM
          }
        SdkNavigationEvent(
          timestamp = timestamp,
          applicationId = appId,
          destination = obj.optString("destination"),
          source = source,
          arguments = obj.optJSONObject("arguments")?.let { jsonObjectToMap(it) },
          metadata = obj.optJSONObject("metadata")?.let { jsonObjectToMap(it) },
        )
      }
      "handled_exception" ->
        SdkHandledExceptionEvent(
          timestamp = timestamp,
          applicationId = appId,
          exceptionClass = obj.optString("exceptionClass"),
          exceptionMessage = obj.optString("exceptionMessage").ifEmpty { null },
          stackTrace = obj.optString("stackTrace"),
          customMessage = obj.optString("customMessage").ifEmpty { null },
          currentScreen = obj.optString("currentScreen").ifEmpty { null },
          appVersion = obj.optString("appVersion").ifEmpty { null },
          deviceInfo = deserializeDeviceInfo(obj.optJSONObject("deviceInfo")),
        )
      "notification_action" ->
        SdkNotificationActionEvent(
          timestamp = timestamp,
          applicationId = appId,
          notificationId = obj.optString("notificationId"),
          actionId = obj.optString("actionId"),
          actionLabel = obj.optString("actionLabel"),
        )
      "recomposition_snapshot" ->
        SdkRecompositionSnapshotEvent(
          timestamp = timestamp,
          applicationId = appId,
          snapshotJson = obj.optString("snapshotJson"),
        )
      "crash" ->
        SdkCrashEvent(
          timestamp = timestamp,
          applicationId = appId,
          exceptionClass = obj.optString("exceptionClass"),
          exceptionMessage = obj.optString("exceptionMessage").ifEmpty { null },
          stackTrace = obj.optString("stackTrace"),
          threadName = obj.optString("threadName"),
          currentScreen = obj.optString("currentScreen").ifEmpty { null },
          appVersion = obj.optString("appVersion").ifEmpty { null },
          deviceInfo = deserializeDeviceInfo(obj.optJSONObject("deviceInfo")),
        )
      "anr" ->
        SdkAnrEvent(
          timestamp = timestamp,
          applicationId = appId,
          pid = obj.optInt("pid"),
          processName = obj.optString("processName"),
          importance = obj.optString("importance"),
          trace = obj.optString("trace").ifEmpty { null },
          reason = obj.optString("reason"),
          appVersion = obj.optString("appVersion").ifEmpty { null },
          deviceInfo = deserializeDeviceInfo(obj.optJSONObject("deviceInfo")),
        )
      "network_request" ->
        SdkNetworkRequestEvent(
          timestamp = timestamp,
          applicationId = appId,
          url = obj.optString("url"),
          method = obj.optString("method"),
          statusCode = obj.optInt("statusCode"),
          durationMs = obj.optLong("durationMs"),
          requestBodySize = obj.optLong("requestBodySize", -1),
          responseBodySize = obj.optLong("responseBodySize", -1),
          protocol = obj.optString("protocol").ifEmpty { null },
          host = obj.optString("host").ifEmpty { null },
          path = obj.optString("path").ifEmpty { null },
          error = obj.optString("error").ifEmpty { null },
          requestHeaders = obj.optJSONObject("requestHeaders")?.let { jsonObjectToMap(it) },
          responseHeaders = obj.optJSONObject("responseHeaders")?.let { jsonObjectToMap(it) },
          requestBody = obj.optString("requestBody").ifEmpty { null },
          responseBody = obj.optString("responseBody").ifEmpty { null },
          contentType = obj.optString("contentType").ifEmpty { null },
        )
      "websocket_frame" -> {
        val direction =
          try {
            WebSocketFrameDirection.valueOf(obj.optString("direction"))
          } catch (_: Exception) {
            WebSocketFrameDirection.RECEIVED
          }
        val frameType =
          try {
            WebSocketFrameType.valueOf(obj.optString("frameType"))
          } catch (_: Exception) {
            WebSocketFrameType.TEXT
          }
        SdkWebSocketFrameEvent(
          timestamp = timestamp,
          applicationId = appId,
          connectionId = obj.optString("connectionId"),
          url = obj.optString("url"),
          direction = direction,
          frameType = frameType,
          payloadSize = obj.optLong("payloadSize"),
          success = obj.optBoolean("success", true),
        )
      }
      "log" ->
        SdkLogEvent(
          timestamp = timestamp,
          applicationId = appId,
          level = obj.optInt("level"),
          tag = obj.optString("tag"),
          message = obj.optString("message"),
          pid = obj.optInt("pid"),
          tid = obj.optInt("tid"),
        )
      "broadcast" -> {
        val categories =
          obj.optJSONArray("categories")?.let { arr ->
            (0 until arr.length()).map { arr.optString(it) }
          }
        SdkBroadcastEvent(
          timestamp = timestamp,
          applicationId = appId,
          action = obj.optString("action"),
          categories = categories,
          extraKeys = obj.optJSONObject("extraKeys")?.let { jsonObjectToMap(it) },
        )
      }
      "lifecycle" ->
        SdkLifecycleEvent(
          timestamp = timestamp,
          applicationId = appId,
          kind = obj.optString("kind"),
          details = obj.optJSONObject("details")?.let { jsonObjectToMap(it) },
        )
      else -> null // Unknown type, skip gracefully
    }

  private fun deserializeDeviceInfo(obj: JSONObject?): SdkDeviceInfo? {
    if (obj == null) return null
    return SdkDeviceInfo(
      model = obj.optString("model"),
      manufacturer = obj.optString("manufacturer"),
      osVersion = obj.optString("osVersion"),
      sdkInt = obj.optInt("sdkInt"),
    )
  }

  private fun jsonObjectToMap(obj: JSONObject?): Map<String, String> {
    if (obj == null) return emptyMap()
    return obj.keys().asSequence().associateWith { key -> obj.optString(key) }
  }
}
