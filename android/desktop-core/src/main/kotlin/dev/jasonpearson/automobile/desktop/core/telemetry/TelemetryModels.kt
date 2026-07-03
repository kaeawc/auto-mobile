package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.ui.graphics.vector.ImageVector
import dev.jasonpearson.automobile.desktop.core.theme.AppIcons
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** Subscribe/unsubscribe/pong commands sent to the telemetry push socket server. */
@Serializable
data class TelemetryPushRequest(
  val id: String,
  val command: String,
  val category: String? = null,
  val deviceId: String? = null,
  val sessionId: String? = null,
)

/** Response envelope from the telemetry push socket server. */
@Serializable
data class TelemetryPushResponse(
  val id: String? = null,
  val type: String,
  val success: Boolean? = null,
  val error: String? = null,
  val timestamp: Long? = null,
  val data: TelemetryEventEnvelope? = null,
)

/** Telemetry event as pushed from the server: category + timestamp + opaque data object. */
@Serializable
data class TelemetryEventEnvelope(
  val category: String,
  val timestamp: Long,
  val deviceId: String? = null,
  val data: JsonObject,
)

/** A single frame in a failure stack trace. */
data class StackTraceFrame(
  val className: String,
  val methodName: String,
  val fileName: String?,
  val lineNumber: Int?,
  val isAppCode: Boolean,
)

data class AccessibilityViolationInfo(
  val type: String,
  val severity: String,
  val criterion: String,
  val message: String,
)

/** Parsed telemetry events for UI rendering, with category-specific fields extracted. */
sealed class TelemetryDisplayEvent {
  abstract val timestamp: Long
  /** Device ID that generated this event, if known. Used for per-device filtering. */
  open val deviceId: String? = null

  data class Network(
    override val timestamp: Long,
    val method: String,
    val statusCode: Int,
    val url: String,
    val durationMs: Long,
    val host: String?,
    val path: String?,
    val error: String?,
    val requestHeaders: Map<String, String>?,
    val responseHeaders: Map<String, String>?,
    val requestBody: String?,
    val responseBody: String?,
    val contentType: String?,
  ) : TelemetryDisplayEvent() {
    /** Lazily parsed request body JSON — only decoded on first access. */
    val parsedRequestBody: JsonObject? by lazy {
      requestBody?.let {
        try {
          telemetryJson.parseToJsonElement(it).jsonObject
        } catch (_: Exception) {
          null
        }
      }
    }

    /** Lazily parsed response body JSON — only decoded on first access. */
    val parsedResponseBody: JsonObject? by lazy {
      responseBody?.let {
        try {
          telemetryJson.parseToJsonElement(it).jsonObject
        } catch (_: Exception) {
          null
        }
      }
    }
  }

  data class Log(
    override val timestamp: Long,
    val level: Int,
    val tag: String,
    val message: String,
  ) : TelemetryDisplayEvent()

  data class Os(
    override val timestamp: Long,
    val category: String,
    val kind: String,
    val details: Map<String, String>?,
  ) : TelemetryDisplayEvent()

  data class Navigation(
    override val timestamp: Long,
    val destination: String,
    val source: String?,
    val arguments: Map<String, String>?,
    val metadata: Map<String, String>?,
    val triggeringInteraction: String?,
    val screenshotUri: String?,
  ) : TelemetryDisplayEvent()

  data class Failure(
    override val timestamp: Long,
    val type: String, // "crash", "anr", "nonfatal"
    val occurrenceId: String,
    val severity: String,
    val title: String,
    val exceptionType: String?,
    val screen: String?,
    val stackTrace: List<StackTraceFrame>?,
  ) : TelemetryDisplayEvent() {
    /** Lazily formatted stack trace string — only built on first access. */
    val formattedStackTrace: String by lazy {
      stackTrace?.joinToString("\n") { frame ->
        val location =
          if (frame.fileName != null && frame.lineNumber != null) {
            "(${frame.fileName}:${frame.lineNumber})"
          } else {
            ""
          }
        "${frame.className}.${frame.methodName}$location"
      } ?: ""
    }
  }

  data class Storage(
    override val timestamp: Long,
    val fileName: String,
    val key: String?,
    val value: String?,
    val valueType: String?,
    val changeType: String,
    val previousValue: String?,
  ) : TelemetryDisplayEvent()

  data class ToolCall(
    override val timestamp: Long,
    val toolName: String,
    val durationMs: Long,
    val success: Boolean,
    val error: String?,
  ) : TelemetryDisplayEvent()

  data class Accessibility(
    override val timestamp: Long,
    val packageName: String,
    val screenId: String,
    val totalViolations: Int,
    val newViolations: Int,
    val baselinedCount: Int,
    val violations: List<AccessibilityViolationInfo>,
  ) : TelemetryDisplayEvent()

  data class Memory(
    override val timestamp: Long,
    val packageName: String,
    val passed: Boolean,
    val javaHeapGrowthMb: Double?,
    val nativeHeapGrowthMb: Double?,
    val gcCount: Int?,
    val gcDurationMs: Long?,
    val unreachableObjects: Int?,
    val violations: List<String>,
  ) : TelemetryDisplayEvent()

  data class Performance(
    override val timestamp: Long,
    val fps: Double?,
    val frameTimeMs: Double?,
    val jankFrames: Int?,
    val touchLatencyMs: Double?,
    val memoryUsageMb: Double?,
    val cpuUsagePercent: Double?,
    val health: String,
    val changedMetrics: List<String>,
  ) : TelemetryDisplayEvent()

  data class Layout(
    override val timestamp: Long,
    val subType: String,
    val composableName: String?,
    val recompositionCount: Int?,
    val durationMs: Long?,
    val likelyCause: String?,
    val screenName: String?,
    val detailsJson: String?,
  ) : TelemetryDisplayEvent() {
    /** Lazily parsed JSON details — only decoded on first access. */
    val parsedDetails: JsonObject? by lazy {
      detailsJson?.let {
        try {
          telemetryJson.parseToJsonElement(it).jsonObject
        } catch (_: Exception) {
          null
        }
      }
    }
  }
}

private val telemetryJson = Json { ignoreUnknownKeys = true }

/**
 * Converts a [TelemetryEventEnvelope] into a typed [TelemetryDisplayEvent] by extracting fields
 * from the JSON data object based on category.
 */
fun parseTelemetryEvent(envelope: TelemetryEventEnvelope): TelemetryDisplayEvent? {
  val d = envelope.data
  return when (envelope.category) {
    "network" -> {
      val reqHeaders = mutableMapOf<String, String>()
      d["requestHeaders"]
        ?.takeIf { it !is kotlinx.serialization.json.JsonNull }
        ?.jsonObject
        ?.forEach { (k, v) -> reqHeaders[k] = v.jsonPrimitive.content }
      val respHeaders = mutableMapOf<String, String>()
      d["responseHeaders"]
        ?.takeIf { it !is kotlinx.serialization.json.JsonNull }
        ?.jsonObject
        ?.forEach { (k, v) -> respHeaders[k] = v.jsonPrimitive.content }
      // Also check snake_case variants from backfill
      if (reqHeaders.isEmpty()) {
        val reqJson = d.stringOrNull("request_headers_json")
        if (reqJson != null) {
          try {
            telemetryJson.parseToJsonElement(reqJson).jsonObject.forEach { (k, v) ->
              reqHeaders[k] = v.jsonPrimitive.content
            }
          } catch (_: Exception) {}
        }
      }
      if (respHeaders.isEmpty()) {
        val respJson = d.stringOrNull("response_headers_json")
        if (respJson != null) {
          try {
            telemetryJson.parseToJsonElement(respJson).jsonObject.forEach { (k, v) ->
              respHeaders[k] = v.jsonPrimitive.content
            }
          } catch (_: Exception) {}
        }
      }
      TelemetryDisplayEvent.Network(
        timestamp = envelope.timestamp,
        method = d.stringOrDefault("method", "?"),
        statusCode =
          d["statusCode"]?.jsonPrimitive?.intOrNull
            ?: d["status_code"]?.jsonPrimitive?.intOrNull
            ?: 0,
        url = d.stringOrDefault("url", ""),
        durationMs =
          d["durationMs"]?.jsonPrimitive?.longOrNull
            ?: d["duration_ms"]?.jsonPrimitive?.longOrNull
            ?: 0,
        host = d.stringOrNull("host"),
        path = d.stringOrNull("path"),
        error = d.stringOrNull("error"),
        requestHeaders = reqHeaders.ifEmpty { null },
        responseHeaders = respHeaders.ifEmpty { null },
        requestBody = d.stringOrNull("requestBody") ?: d.stringOrNull("request_body"),
        responseBody = d.stringOrNull("responseBody") ?: d.stringOrNull("response_body"),
        contentType = d.stringOrNull("contentType") ?: d.stringOrNull("content_type"),
      )
    }
    "log" ->
      TelemetryDisplayEvent.Log(
        timestamp = envelope.timestamp,
        level = d["level"]?.jsonPrimitive?.intOrNull ?: 4, // default INFO
        tag = d.stringOrDefault("tag", ""),
        message = d.stringOrDefault("message", ""),
      )
    "custom" -> {
      // Custom events are merged into log events
      val name = d.stringOrDefault("name", "unknown")
      val props = mutableMapOf<String, String>()
      d["properties"]?.jsonObject?.forEach { (k, v) ->
        props[k] = v.jsonPrimitive.content
      }
      val propsJson = d.stringOrNull("properties_json")
      if (props.isEmpty() && propsJson != null) {
        try {
          val parsed = telemetryJson.parseToJsonElement(propsJson).jsonObject
          parsed.forEach { (k, v) -> props[k] = v.jsonPrimitive.content }
        } catch (_: Exception) {
          /* ignore parse failures */
        }
      }
      val propsStr =
        if (props.isNotEmpty()) {
          " {${props.entries.joinToString(", ") { "${it.key}:${it.value}" }}}"
        } else ""
      TelemetryDisplayEvent.Log(
        timestamp = envelope.timestamp,
        level = 4, // INFO
        tag = "CustomEvent",
        message = "$name$propsStr",
      )
    }
    "os" -> {
      val details = mutableMapOf<String, String>()
      d["details"]?.jsonObject?.forEach { (k, v) ->
        details[k] = v.jsonPrimitive.content
      }
      val detailsJson = d.stringOrNull("details_json")
      if (details.isEmpty() && detailsJson != null) {
        try {
          val parsed = telemetryJson.parseToJsonElement(detailsJson).jsonObject
          parsed.forEach { (k, v) -> details[k] = v.jsonPrimitive.content }
        } catch (_: Exception) {
          /* ignore parse failures */
        }
      }
      TelemetryDisplayEvent.Os(
        timestamp = envelope.timestamp,
        category = d.stringOrDefault("category", "unknown"),
        kind = d.stringOrDefault("kind", "unknown"),
        details = details.ifEmpty { null },
      )
    }
    "navigation" -> {
      val args = mutableMapOf<String, String>()
      d["arguments"]
        ?.takeIf { it !is kotlinx.serialization.json.JsonNull }
        ?.jsonObject
        ?.forEach { (k, v) -> args[k] = v.jsonPrimitive.content }
      val meta = mutableMapOf<String, String>()
      d["metadata"]
        ?.takeIf { it !is kotlinx.serialization.json.JsonNull }
        ?.jsonObject
        ?.forEach { (k, v) -> meta[k] = v.jsonPrimitive.content }
      // Build human-readable triggering interaction summary
      val trigInteraction =
        d["triggeringInteraction"]
          ?.takeIf { it !is kotlinx.serialization.json.JsonNull }
          ?.jsonObject
          ?.let { ti ->
            val interType = ti.stringOrNull("type") ?: "interaction"
            val elText = ti.stringOrNull("elementText")
            val elResId = ti.stringOrNull("elementResourceId")
            val target = elText ?: elResId
            if (target != null) "$interType on '$target'" else interType
          }
      TelemetryDisplayEvent.Navigation(
        timestamp = envelope.timestamp,
        destination = d.stringOrDefault("destination", "unknown"),
        source = d.stringOrNull("source"),
        arguments = args.ifEmpty { null },
        metadata = meta.ifEmpty { null },
        triggeringInteraction = trigInteraction,
        screenshotUri = d.stringOrNull("screenshotUri"),
      )
    }
    "crash",
    "anr",
    "nonfatal" -> {
      val frames =
        try {
          d["stackTrace"]
            ?.takeIf { it !is kotlinx.serialization.json.JsonNull }
            ?.jsonArray
            ?.map { frame ->
              val f = frame.jsonObject
              StackTraceFrame(
                className = f.stringOrDefault("className", ""),
                methodName = f.stringOrDefault("methodName", ""),
                fileName = f.stringOrNull("fileName"),
                lineNumber = f["lineNumber"]?.jsonPrimitive?.intOrNull,
                isAppCode = f["isAppCode"]?.jsonPrimitive?.booleanOrNull ?: false,
              )
            }
        } catch (_: Exception) {
          null
        }
      TelemetryDisplayEvent.Failure(
        timestamp = envelope.timestamp,
        type = envelope.category,
        occurrenceId = d.stringOrDefault("occurrenceId", ""),
        severity = d.stringOrDefault("severity", "medium"),
        title = d.stringOrDefault("title", "Unknown failure"),
        exceptionType = d.stringOrNull("exceptionType"),
        screen = d.stringOrNull("screen"),
        stackTrace = frames,
      )
    }
    "storage" ->
      TelemetryDisplayEvent.Storage(
        timestamp = envelope.timestamp,
        fileName = d.stringOrDefault("fileName", d.stringOrDefault("file_name", "unknown")),
        key = d.stringOrNull("key"),
        value = d.stringOrNull("value"),
        valueType = d.stringOrNull("valueType") ?: d.stringOrNull("value_type"),
        changeType = d.stringOrDefault("changeType", d.stringOrDefault("change_type", "modify")),
        previousValue = d.stringOrNull("previousValue") ?: d.stringOrNull("previous_value"),
      )
    "layout" ->
      TelemetryDisplayEvent.Layout(
        timestamp = envelope.timestamp,
        subType = d.stringOrDefault("subType", d.stringOrDefault("sub_type", "unknown")),
        composableName = d.stringOrNull("composableName") ?: d.stringOrNull("composable_name"),
        recompositionCount =
          d["recompositionCount"]?.jsonPrimitive?.intOrNull
            ?: d["recomposition_count"]?.jsonPrimitive?.intOrNull,
        screenName = d.stringOrNull("screenName") ?: d.stringOrNull("screen_name"),
        detailsJson = d.stringOrNull("detailsJson") ?: d.stringOrNull("details_json"),
        durationMs =
          d["durationMs"]?.jsonPrimitive?.longOrNull ?: d["duration_ms"]?.jsonPrimitive?.longOrNull,
        likelyCause = d.stringOrNull("likelyCause") ?: d.stringOrNull("likely_cause"),
      )
    "toolcall" ->
      TelemetryDisplayEvent.ToolCall(
        timestamp = envelope.timestamp,
        toolName = d.stringOrDefault("toolName", "unknown"),
        durationMs = d["durationMs"]?.jsonPrimitive?.longOrNull ?: 0,
        success = d["success"]?.jsonPrimitive?.booleanOrNull ?: true,
        error = d.stringOrNull("error"),
      )
    "accessibility" -> {
      val violationsList =
        try {
          d["violations"]?.jsonArray?.map { v ->
            val vObj = v.jsonObject
            AccessibilityViolationInfo(
              type = vObj.stringOrDefault("type", "unknown"),
              severity = vObj.stringOrDefault("severity", "warning"),
              criterion = vObj.stringOrDefault("criterion", ""),
              message = vObj.stringOrDefault("message", ""),
            )
          } ?: emptyList()
        } catch (_: Exception) {
          emptyList()
        }
      TelemetryDisplayEvent.Accessibility(
        timestamp = envelope.timestamp,
        packageName = d.stringOrDefault("packageName", "unknown"),
        screenId = d.stringOrDefault("screenId", ""),
        totalViolations = d["totalViolations"]?.jsonPrimitive?.intOrNull ?: 0,
        newViolations = d["newViolations"]?.jsonPrimitive?.intOrNull ?: 0,
        baselinedCount = d["baselinedCount"]?.jsonPrimitive?.intOrNull ?: 0,
        violations = violationsList,
      )
    }
    "interaction",
    "gesture",
    "input" -> null // Filtered out — too noisy
    "memory" -> {
      val violations =
        try {
          d["violations"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
        } catch (_: Exception) {
          emptyList()
        }
      TelemetryDisplayEvent.Memory(
        timestamp = envelope.timestamp,
        packageName = d.stringOrDefault("packageName", "unknown"),
        passed = d["passed"]?.jsonPrimitive?.booleanOrNull ?: true,
        javaHeapGrowthMb = d["javaHeapGrowthMb"]?.jsonPrimitive?.doubleOrNull,
        nativeHeapGrowthMb = d["nativeHeapGrowthMb"]?.jsonPrimitive?.doubleOrNull,
        gcCount = d["gcCount"]?.jsonPrimitive?.intOrNull,
        gcDurationMs = d["gcDurationMs"]?.jsonPrimitive?.longOrNull,
        unreachableObjects = d["unreachableObjects"]?.jsonPrimitive?.intOrNull,
        violations = violations,
      )
    }
    "performance" -> {
      val changed =
        try {
          d["changedMetrics"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
        } catch (_: Exception) {
          emptyList()
        }
      TelemetryDisplayEvent.Performance(
        timestamp = envelope.timestamp,
        fps = d["fps"]?.jsonPrimitive?.doubleOrNull,
        frameTimeMs = d["frameTimeMs"]?.jsonPrimitive?.doubleOrNull,
        jankFrames = d["jankFrames"]?.jsonPrimitive?.intOrNull,
        touchLatencyMs = d["touchLatencyMs"]?.jsonPrimitive?.doubleOrNull,
        memoryUsageMb = d["memoryUsageMb"]?.jsonPrimitive?.doubleOrNull,
        cpuUsagePercent = d["cpuUsagePercent"]?.jsonPrimitive?.doubleOrNull,
        health = d.stringOrDefault("health", "healthy"),
        changedMetrics = changed,
      )
    }
    else -> null
  }
}

private fun JsonObject.stringOrDefault(key: String, default: String): String =
  this[key]?.jsonPrimitive?.content ?: default

private fun JsonObject.stringOrNull(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull

/** Severity classification for telemetry events, used for filter toggles. */
enum class EventSeverity(val label: String, val icon: ImageVector, val color: Long) {
  Error("Errors", AppIcons.SeverityError, 0xFFFF6B6B),
  Warning("Warnings", AppIcons.SeverityWarning, 0xFFE0C040),
  Info("Info", AppIcons.SeverityInfo, 0xFF74C0FC),
}

/**
 * Classify a telemetry event into a severity level.
 *
 * @param slowNetworkThresholdMs Requests slower than this are classified as Warning (default
 *   3000ms)
 */
fun TelemetryDisplayEvent.classifyEventSeverity(
  slowNetworkThresholdMs: Long = 3000
): EventSeverity =
  when (this) {
    is TelemetryDisplayEvent.Failure ->
      when (type) {
        "crash",
        "anr" -> EventSeverity.Error
        "nonfatal" -> EventSeverity.Warning
        else -> EventSeverity.Warning
      }
    is TelemetryDisplayEvent.Log ->
      when (level) {
        6,
        7 -> EventSeverity.Error
        5 -> EventSeverity.Warning
        else -> EventSeverity.Info
      }
    is TelemetryDisplayEvent.Network ->
      when {
        error != null -> EventSeverity.Error
        statusCode == 0 -> EventSeverity.Error
        statusCode >= 400 -> EventSeverity.Error
        durationMs >= slowNetworkThresholdMs -> EventSeverity.Warning
        else -> EventSeverity.Info
      }
    is TelemetryDisplayEvent.Layout ->
      when (subType) {
        "excessive_recomposition" -> EventSeverity.Warning
        else -> EventSeverity.Info
      }
    is TelemetryDisplayEvent.Performance ->
      when (health) {
        "critical" -> EventSeverity.Error
        "warning" -> EventSeverity.Warning
        else -> EventSeverity.Info
      }
    is TelemetryDisplayEvent.ToolCall ->
      when {
        !success -> EventSeverity.Error
        durationMs > 5000 -> EventSeverity.Warning
        else -> EventSeverity.Info
      }
    is TelemetryDisplayEvent.Accessibility ->
      when {
        newViolations > 0 -> EventSeverity.Warning
        else -> EventSeverity.Info
      }
    is TelemetryDisplayEvent.Memory ->
      when {
        !passed -> EventSeverity.Error
        else -> EventSeverity.Info
      }
    else -> EventSeverity.Info
  }

/** Convenience property using default threshold */
val TelemetryDisplayEvent.eventSeverity: EventSeverity
  get() = classifyEventSeverity()

/**
 * Full-text search across all relevant fields of a telemetry event.
 *
 * @param useRegex When true, [query] is compiled as a case-insensitive regex. Invalid regex
 *   patterns gracefully return false (no match).
 */
fun TelemetryDisplayEvent.matchesSearch(query: String, useRegex: Boolean = false): Boolean {
  if (query.isBlank()) return true

  if (useRegex) {
    val regex =
      try {
        Regex(query, RegexOption.IGNORE_CASE)
      } catch (_: java.util.regex.PatternSyntaxException) {
        return false
      }
    return anyField { regex.containsMatchIn(it) }
  }

  val q = query.lowercase()
  return anyField { it.lowercase().contains(q) }
}

/**
 * Short-circuit iteration over searchable fields. Avoids allocating intermediate lists -- the
 * [predicate] is tested lazily and returns as soon as the first match is found.
 */
private inline fun TelemetryDisplayEvent.anyField(predicate: (String) -> Boolean): Boolean =
  when (this) {
    is TelemetryDisplayEvent.Network ->
      predicate(method) ||
        predicate("$statusCode") ||
        predicate(url) ||
        host?.let(predicate) == true ||
        path?.let(predicate) == true ||
        error?.let(predicate) == true
    is TelemetryDisplayEvent.Log -> predicate(tag) || predicate(message)
    is TelemetryDisplayEvent.Navigation ->
      predicate(destination) ||
        source?.let(predicate) == true ||
        triggeringInteraction?.let(predicate) == true ||
        arguments?.values?.any(predicate) == true
    is TelemetryDisplayEvent.Os ->
      predicate(category) || predicate(kind) || details?.values?.any(predicate) == true
    is TelemetryDisplayEvent.Failure ->
      predicate(type) ||
        predicate(title) ||
        exceptionType?.let(predicate) == true ||
        screen?.let(predicate) == true
    is TelemetryDisplayEvent.Storage ->
      predicate(fileName) ||
        key?.let(predicate) == true ||
        value?.let(predicate) == true ||
        predicate(changeType)
    is TelemetryDisplayEvent.Layout ->
      predicate(subType) ||
        composableName?.let(predicate) == true ||
        screenName?.let(predicate) == true ||
        likelyCause?.let(predicate) == true
    is TelemetryDisplayEvent.Performance ->
      predicate(health) || changedMetrics.any(predicate) || predicate("performance")
    is TelemetryDisplayEvent.ToolCall -> predicate(toolName) || error?.let(predicate) == true
    is TelemetryDisplayEvent.Accessibility ->
      predicate(packageName) ||
        predicate(screenId) ||
        violations.any { predicate(it.type) || predicate(it.message) }
    is TelemetryDisplayEvent.Memory ->
      predicate(packageName) || violations.any(predicate) || predicate("memory")
  }
