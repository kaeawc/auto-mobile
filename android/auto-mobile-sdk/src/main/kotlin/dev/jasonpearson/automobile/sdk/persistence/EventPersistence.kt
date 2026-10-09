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
import dev.jasonpearson.automobile.sdk.events.DropCounter
import dev.jasonpearson.automobile.sdk.events.DropReason
import dev.jasonpearson.automobile.sdk.logging.DefaultSdkLogger
import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/** Storage identity is separate from delivery identity: retry accounting renames the file. */
internal data class PendingEventBatch(
  val storageId: String,
  val events: List<SdkEvent>,
  val deliveryId: String? = null,
)

/**
 * Persistence layer for SDK events. Persists event batches to disk so they survive process death
 * and can be replayed on next launch.
 */
internal interface EventPersistence {
  /** Persist events and their delivery id. Returns the storage id on success, null on failure. */
  fun persist(events: List<SdkEvent>, deliveryId: String? = null): String?

  /** Load all pending batches from disk, ordered oldest-first (FIFO). */
  fun loadPending(): List<PendingEventBatch>

  /** Remove a successfully delivered batch by ID. */
  fun removeBatch(batchId: String)

  /** Record a failed replay; return whether the batch is retained for another launch. */
  fun recordReplayFailure(batchId: String): Boolean = true

  /** Remove batches older than [maxAgeDays]. */
  fun cleanup(maxAgeDays: Int = 7)
}

/**
 * File-based event persistence, with no I/O until first use on a background executor.
 *
 * New files use events_s<20-digit sequence>_c<count>_a<attempts>_t<millis>_<uuid>.json. Sequences
 * are recovered from disk on first use, then increase under this lock. Legacy
 * events_<millis>_<uuid>.json files always sort before sequenced files, ordered by (millis,
 * original name). On failure they become events_l<millis>_c<count>_a<attempts>_<original batch
 * ID>.json, retaining that exact legacy ordering even when UUIDs contain underscores.
 */
internal class FileEventPersistence(
  private val directory: File,
  private val clock: () -> Long = System::currentTimeMillis,
  private val uuidProvider: () -> String = { UUID.randomUUID().toString() },
  private val maxPendingBatches: Int = 100,
  private val dropCounter: DropCounter? = null,
  private val maxReplayAttempts: Int = 3,
  private val fileOps: (File) -> Boolean = File::delete,
  private val maxPendingBytes: Long = 10_000_000,
) : EventPersistence {

  // Preserve the published three-argument JVM descriptor. Different parameter names avoid
  // ambiguity with named Kotlin calls to the defaulted primary constructor.
  constructor(
    legacyDirectory: File,
    legacyClock: () -> Long,
    legacyUuidProvider: () -> String,
  ) : this(
    directory = legacyDirectory,
    clock = legacyClock,
    uuidProvider = legacyUuidProvider,
    maxPendingBatches = 100,
  )

  private val logger = DefaultSdkLogger()
  private var nextSequence: Long? = null

  init {
    require(maxPendingBatches > 0)
    require(maxReplayAttempts > 0)
    require(maxPendingBytes > 0)
  }

  private data class BatchFile(
    val file: File,
    val sequence: Long?,
    val timestamp: Long,
    val count: Int?,
    val attempts: Int,
    val identity: String,
  ) {
    val batchId: String
      get() = file.name.removePrefix("events_").removeSuffix(".json")
  }

  private val sequencedName = Regex("s(\\d{20})_c(\\d+)_a(\\d+)_t(-?\\d+)_(.+)")
  private val retriedLegacyName = Regex("l(\\d+)_c(\\d+)_a(\\d+)_(.+)")

  private fun parseFile(file: File): BatchFile? {
    if (!file.name.startsWith("events_") || !file.name.endsWith(".json")) return null
    val id = file.name.removePrefix("events_").removeSuffix(".json")
    sequencedName.matchEntire(id)?.destructured?.let { (seq, count, attempts, time, uuid) ->
      return BatchFile(
        file,
        seq.toLongOrNull() ?: return null,
        time.toLongOrNull() ?: return null,
        count.toIntOrNull() ?: return null,
        attempts.toIntOrNull() ?: return null,
        uuid,
      )
    }
    retriedLegacyName.matchEntire(id)?.destructured?.let { (time, count, attempts, original) ->
      return BatchFile(
        file,
        null,
        time.toLongOrNull() ?: return null,
        count.toIntOrNull() ?: return null,
        attempts.toIntOrNull() ?: return null,
        original,
      )
    }
    val time = id.substringBefore('_').toLongOrNull() ?: return null
    return BatchFile(file, null, time, null, 0, id)
  }

  private fun pendingFiles(): List<BatchFile> =
    directory
      .listFiles()
      ?.mapNotNull(::parseFile)
      ?.sortedWith(
        compareBy<BatchFile> { it.sequence != null }
          .thenBy { it.sequence ?: it.timestamp }
          .thenBy { it.identity },
      ) ?: emptyList()

  private fun initializeSequence() {
    if (nextSequence == null) {
      nextSequence = (pendingFiles().mapNotNull { it.sequence }.maxOrNull() ?: 0) + 1
    }
  }

  private fun allocateSequence(): Long {
    initializeSequence()
    val sequence = checkNotNull(nextSequence)
    nextSequence = sequence + 1
    return sequence
  }

  private fun eventCount(batch: BatchFile): Int =
    batch.count
      ?: try {
        JSONArray(batch.file.readText()).length()
      } catch (_: Exception) {
        // Unreadable legacy batches have no count metadata; account for at least one lost event.
        1
      }

  /** True also means already absent; only an actual deletion increments the counter. */
  private fun deleteDropped(batch: BatchFile, reason: DropReason): Boolean {
    if (!batch.file.exists()) return true
    val count = eventCount(batch)
    if (fileOps(batch.file)) {
      dropCounter?.increment(reason, count)
      logger.w("EventPersistence") { "Dropped $count pending events: $reason" }
      return true
    }
    if (!batch.file.exists()) return true
    logger.w("EventPersistence") {
      "Could not delete pending batch ${batch.file.name}; retaining it"
    }
    return false
  }

  @Synchronized
  override fun persist(events: List<SdkEvent>, deliveryId: String?): String? {
    if (events.isEmpty()) return null
    var file: File? = null
    val batchId =
      try {
        val sequence = allocateSequence().toString().padStart(20, '0')
        val id = "s${sequence}_c${events.size}_a0_t${clock()}_${uuidProvider()}"
        // The host can clear its cache at any time, including after earlier successful writes.
        directory.mkdirs()
        val target = File(directory, "events_$id.json")
        file = target
        val json = serializePendingBatch(events, deliveryId)
        if (json.toByteArray(Charsets.UTF_8).size > maxPendingBytes) {
          logger.w("EventPersistence") {
            "Pending batch exceeds $maxPendingBytes bytes; not retained"
          }
          return null // The buffer owns failure accounting when persistence returns null.
        }
        target.writeText(json)
        id
      } catch (_: Exception) {
        // A partial write is not a retained batch; report the failure to the buffer.
        runCatching { file?.let(fileOps) }
        return null
      }
    try {
      val files = pendingFiles()
      var excess = files.size - maxPendingBatches
      var bytes = files.sumOf { it.file.length() }
      for (victim in files) {
        if (excess <= 0 && bytes <= maxPendingBytes) break
        if (victim.batchId == batchId) continue
        val victimBytes = victim.file.length()
        if (!deleteDropped(victim, DropReason.BUFFER_OVERFLOW)) break
        excess--
        bytes -= victimBytes
      }
    } catch (error: Exception) {
      // Eviction failure must never destroy the newly written batch.
      logger.w("EventPersistence", error) { "Could not evict pending batches; keeping new batch" }
    }
    return batchId
  }

  @Synchronized
  override fun loadPending(): List<PendingEventBatch> =
    try {
      initializeSequence()
      pendingFiles().mapNotNull { batch ->
        try {
          deserializePendingBatch(batch.batchId, batch.file.readText())
        } catch (_: Exception) {
          // Corrupt files cannot replay; count only a file actually removed.
          deleteDropped(batch, DropReason.DELIVERY_FAILED)
          null
        }
      }
    } catch (error: Exception) {
      logger.w("EventPersistence", error) { "Could not read pending batches; retaining files" }
      emptyList()
    }

  @Synchronized
  override fun removeBatch(batchId: String) {
    try {
      initializeSequence()
      val file = File(directory, "events_$batchId.json")
      if (!fileOps(file) && file.exists()) {
        logger.w("EventPersistence") { "Could not remove delivered batch $batchId" }
      }
    } catch (error: Exception) {
      logger.w("EventPersistence", error) { "Could not remove delivered batch $batchId" }
    }
  }

  @Synchronized
  override fun cleanup(maxAgeDays: Int) {
    try {
      initializeSequence()
      val cutoff = clock() - maxAgeDays * 24 * 60 * 60 * 1000L
      pendingFiles()
        .filter { it.timestamp < cutoff }
        .forEach {
          deleteDropped(it, DropReason.DELIVERY_FAILED)
        }
    } catch (error: Exception) {
      logger.w("EventPersistence", error) { "Could not clean up pending batches; retaining files" }
    }
  }

  @Synchronized
  override fun recordReplayFailure(batchId: String): Boolean {
    try {
      initializeSequence()
      val batch = parseFile(File(directory, "events_$batchId.json")) ?: return true
      if (!batch.file.exists()) return false
      val attempts = batch.attempts + 1
      if (attempts >= maxReplayAttempts) return !deleteDropped(batch, DropReason.DELIVERY_FAILED)
      val count = eventCount(batch)
      val id =
        if (batch.sequence == null) {
          "l${batch.timestamp}_c${count}_a${attempts}_${batch.identity}"
        } else {
          val sequence = batch.sequence.toString().padStart(20, '0')
          "s${sequence}_c${count}_a${attempts}_t${batch.timestamp}_${batch.identity}"
        }
      if (!batch.file.renameTo(File(directory, "events_$id.json"))) {
        logger.w("EventPersistence") {
          "Could not record replay failure for $batchId; retaining it"
        }
      }
    } catch (error: Exception) {
      logger.w("EventPersistence", error) { "Could not record replay failure; retaining batch" }
    }
    return true
  }

  // Old array-only files have no delivery identity. Keep them replayable without rewriting disk.
  private fun deserializePendingBatch(storageId: String, json: String): PendingEventBatch =
    when (val value = JSONTokener(json).nextValue()) {
      is JSONArray -> PendingEventBatch(storageId, deserializeEvents(value.toString()))
      is JSONObject ->
        PendingEventBatch(
          storageId,
          deserializeEvents(value.getJSONArray("events").toString()),
          if (value.isNull("batchId")) null else value.getString("batchId"),
        )
      else -> error("Invalid persisted event batch")
    }

  internal fun serializePendingBatch(events: List<SdkEvent>, deliveryId: String?): String =
    JSONObject()
      .put("batchId", deliveryId ?: JSONObject.NULL)
      .put("events", JSONArray(serializeEvents(events)))
      .toString()

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
