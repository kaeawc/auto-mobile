package dev.jasonpearson.automobile.desktop.core.telemetry

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/** Subscribe/unsubscribe/pong commands sent to the telemetry push socket server. */
@Serializable
data class TelemetryPushRequest(
  val id: String,
  val command: String,
  val category: String? = null,
  val deviceId: String? = null,
  val sessionId: String? = null,
  val sessionUuid: String? = null,
  val deviceSessionUuid: String? = null,
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
        } catch (error: IllegalArgumentException) {
          dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory.getLogger("Telemetry")
            .debug("Invalid optional event data: ${error.message}")
          null
        }
      }
    }

    /** Lazily parsed response body JSON — only decoded on first access. */
    val parsedResponseBody: JsonObject? by lazy {
      responseBody?.let {
        try {
          telemetryJson.parseToJsonElement(it).jsonObject
        } catch (error: IllegalArgumentException) {
          dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory.getLogger("Telemetry")
            .debug("Invalid optional event data: ${error.message}")
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
        } catch (error: IllegalArgumentException) {
          dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory.getLogger("Telemetry")
            .debug("Invalid optional event data: ${error.message}")
          null
        }
      }
    }
  }
}

internal val telemetryJson = Json { ignoreUnknownKeys = true }

/**
 * Converts a [TelemetryEventEnvelope] into a typed [TelemetryDisplayEvent] by extracting fields
 * from the JSON data object based on category.
 */
fun parseTelemetryEvent(
  envelope: TelemetryEventEnvelope,
  onFieldMismatch: (String) -> Unit = {},
): TelemetryDisplayEvent? {
  val reader = TelemetryEventReader(envelope, onFieldMismatch)
  return when (envelope.category) {
    "network" -> reader.parseNetwork()
    "log" -> reader.parseLog()
    "custom" -> reader.parseCustom()
    "os" -> reader.parseOs()
    "navigation" -> reader.parseNavigation()
    "crash",
    "anr",
    "nonfatal" -> reader.parseCrash()
    "storage" -> reader.parseStorage()
    else -> reader.parseRuntimeCategory()
  }
}

internal fun JsonElement.displayString(): String =
  if (this is JsonPrimitive) content else toString()
