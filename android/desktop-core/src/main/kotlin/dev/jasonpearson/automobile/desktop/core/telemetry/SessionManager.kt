package dev.jasonpearson.automobile.desktop.core.telemetry

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Manages saving and loading telemetry sessions as `.automobile-session` JSON files.
 */
object SessionManager {

    private val json = Json {
        prettyPrint = true
        ignoreUnknownKeys = true
    }

    /**
     * Saves the current session events to a file.
     */
    fun saveSession(events: List<TelemetryDisplayEvent>, file: File) {
        val session = SessionData(
            version = 1,
            exportedAt = System.currentTimeMillis(),
            events = events.map { it.toSerializable() },
        )
        file.writeText(json.encodeToString(session))
    }

    /**
     * Loads a session from a file, returning the list of events.
     * Returns null if the file cannot be parsed.
     */
    fun loadSession(file: File): List<TelemetryDisplayEvent>? {
        return try {
            val session = json.decodeFromString<SessionData>(file.readText())
            session.events.mapNotNull { it.toDisplayEvent() }
        } catch (_: Exception) {
            null
        }
    }

    @Serializable
    private data class SessionData(
        val version: Int,
        val exportedAt: Long,
        val events: List<SerializableEvent>,
    )

    @Serializable
    private data class SerializableStackFrame(
        val className: String,
        val methodName: String,
        val fileName: String? = null,
        val lineNumber: Int? = null,
        val isAppCode: Boolean,
    )

    @Serializable
    private data class SerializableEvent(
        val type: String,
        val timestamp: Long,
        // Network
        val method: String? = null,
        val statusCode: Int? = null,
        val url: String? = null,
        val durationMs: Long? = null,
        val host: String? = null,
        val path: String? = null,
        val error: String? = null,
        val requestBody: String? = null,
        val responseBody: String? = null,
        val contentType: String? = null,
        // Log
        val level: Int? = null,
        val tag: String? = null,
        val message: String? = null,
        // Custom
        val name: String? = null,
        val properties: Map<String, String>? = null,
        // Os
        val category: String? = null,
        val kind: String? = null,
        val details: Map<String, String>? = null,
        // Navigation
        val destination: String? = null,
        val source: String? = null,
        val arguments: Map<String, String>? = null,
        val metadata: Map<String, String>? = null,
        val triggeringInteraction: String? = null,
        val screenshotUri: String? = null,
        // Failure
        val occurrenceId: String? = null,
        val severity: String? = null,
        val title: String? = null,
        val exceptionType: String? = null,
        val screen: String? = null,
        val stackFrames: List<SerializableStackFrame>? = null,
        // Network headers (stored separately so they survive round-trips)
        val requestHeaders: Map<String, String>? = null,
        val responseHeaders: Map<String, String>? = null,
        // Storage
        val fileName: String? = null,
        val key: String? = null,
        val value: String? = null,
        val valueType: String? = null,
        val changeType: String? = null,
        val previousValue: String? = null,
        // ToolCall
        val toolName: String? = null,
        val success: Boolean? = null,
        // Layout
        val subType: String? = null,
        val composableName: String? = null,
        val recompositionCount: Int? = null,
        val likelyCause: String? = null,
        val screenName: String? = null,
        val detailsJson: String? = null,
        // Performance
        val fps: Double? = null,
        val frameTimeMs: Double? = null,
        val jankFrames: Int? = null,
        val touchLatencyMs: Double? = null,
        val memoryUsageMb: Double? = null,
        val cpuUsagePercent: Double? = null,
        val health: String? = null,
        val changedMetrics: List<String>? = null,
        // Memory
        val packageName: String? = null,
        val passed: Boolean? = null,
        val javaHeapGrowthMb: Double? = null,
        val nativeHeapGrowthMb: Double? = null,
        val gcCount: Int? = null,
        val gcDurationMs: Long? = null,
        val unreachableObjects: Int? = null,
        val violations: List<String>? = null,
        // Accessibility
        val screenId: String? = null,
        val totalViolations: Int? = null,
        val newViolations: Int? = null,
        val baselinedCount: Int? = null,
    )

    private fun TelemetryDisplayEvent.toSerializable(): SerializableEvent = when (this) {
        is TelemetryDisplayEvent.Network -> SerializableEvent(
            type = "network", timestamp = timestamp, method = method, statusCode = statusCode,
            url = url, durationMs = durationMs, host = host, path = path, error = error,
            requestBody = requestBody, responseBody = responseBody, contentType = contentType,
            requestHeaders = requestHeaders, responseHeaders = responseHeaders,
        )
        is TelemetryDisplayEvent.Log -> SerializableEvent(
            type = "log", timestamp = timestamp, level = level, tag = tag, message = message,
        )
        is TelemetryDisplayEvent.Custom -> SerializableEvent(
            type = "custom", timestamp = timestamp, name = name, properties = properties,
        )
        is TelemetryDisplayEvent.Os -> SerializableEvent(
            type = "os", timestamp = timestamp, category = category, kind = kind, details = details,
        )
        is TelemetryDisplayEvent.Navigation -> SerializableEvent(
            type = "navigation", timestamp = timestamp, destination = destination, source = source,
            arguments = arguments, metadata = metadata, triggeringInteraction = triggeringInteraction,
            screenshotUri = screenshotUri,
        )
        is TelemetryDisplayEvent.Failure -> SerializableEvent(
            type = type, timestamp = timestamp, occurrenceId = occurrenceId, severity = severity,
            title = title, exceptionType = exceptionType, screen = screen,
            stackFrames = stackTrace?.map { f ->
                SerializableStackFrame(
                    className = f.className, methodName = f.methodName,
                    fileName = f.fileName, lineNumber = f.lineNumber, isAppCode = f.isAppCode,
                )
            },
        )
        is TelemetryDisplayEvent.Storage -> SerializableEvent(
            type = "storage", timestamp = timestamp, fileName = fileName, key = key, value = value,
            valueType = valueType, changeType = changeType, previousValue = previousValue,
        )
        is TelemetryDisplayEvent.ToolCall -> SerializableEvent(
            type = "toolcall", timestamp = timestamp, toolName = toolName, durationMs = durationMs,
            success = success, error = error,
        )
        is TelemetryDisplayEvent.Accessibility -> SerializableEvent(
            type = "accessibility", timestamp = timestamp, packageName = packageName,
            screenId = screenId, totalViolations = totalViolations, newViolations = newViolations,
            baselinedCount = baselinedCount,
        )
        is TelemetryDisplayEvent.Memory -> SerializableEvent(
            type = "memory", timestamp = timestamp, packageName = packageName, passed = passed,
            javaHeapGrowthMb = javaHeapGrowthMb, nativeHeapGrowthMb = nativeHeapGrowthMb,
            gcCount = gcCount, gcDurationMs = gcDurationMs, unreachableObjects = unreachableObjects,
            violations = violations,
        )
        is TelemetryDisplayEvent.Performance -> SerializableEvent(
            type = "performance", timestamp = timestamp, fps = fps, frameTimeMs = frameTimeMs,
            jankFrames = jankFrames, touchLatencyMs = touchLatencyMs, memoryUsageMb = memoryUsageMb,
            cpuUsagePercent = cpuUsagePercent, health = health, changedMetrics = changedMetrics,
        )
        is TelemetryDisplayEvent.Layout -> SerializableEvent(
            type = "layout", timestamp = timestamp, subType = subType, composableName = composableName,
            recompositionCount = recompositionCount, durationMs = durationMs, likelyCause = likelyCause,
            screenName = screenName, detailsJson = detailsJson,
        )
    }

    private fun SerializableEvent.toDisplayEvent(): TelemetryDisplayEvent? = when (type) {
        "network" -> TelemetryDisplayEvent.Network(
            timestamp = timestamp, method = method ?: "?", statusCode = statusCode ?: 0,
            url = url ?: "", durationMs = durationMs ?: 0, host = host, path = path, error = error,
            requestHeaders = requestHeaders, responseHeaders = responseHeaders,
            requestBody = requestBody, responseBody = responseBody, contentType = contentType,
        )
        "log" -> TelemetryDisplayEvent.Log(
            timestamp = timestamp, level = level ?: 4, tag = tag ?: "", message = message ?: "",
        )
        "custom" -> TelemetryDisplayEvent.Custom(
            timestamp = timestamp, name = name ?: "unknown", properties = properties ?: emptyMap(),
        )
        "os" -> TelemetryDisplayEvent.Os(
            timestamp = timestamp, category = category ?: "unknown", kind = kind ?: "unknown",
            details = details,
        )
        "navigation" -> TelemetryDisplayEvent.Navigation(
            timestamp = timestamp, destination = destination ?: "unknown", source = source,
            arguments = arguments, metadata = metadata, triggeringInteraction = triggeringInteraction,
            screenshotUri = screenshotUri,
        )
        "crash", "anr", "nonfatal" -> TelemetryDisplayEvent.Failure(
            timestamp = timestamp, type = type, occurrenceId = occurrenceId ?: "",
            severity = severity ?: "medium", title = title ?: "Unknown", exceptionType = exceptionType,
            screen = screen,
            stackTrace = stackFrames?.map { f ->
                StackTraceFrame(
                    className = f.className, methodName = f.methodName,
                    fileName = f.fileName, lineNumber = f.lineNumber, isAppCode = f.isAppCode,
                )
            },
        )
        "storage" -> TelemetryDisplayEvent.Storage(
            timestamp = timestamp, fileName = fileName ?: "unknown", key = key, value = value,
            valueType = valueType, changeType = changeType ?: "modify", previousValue = previousValue,
        )
        "toolcall" -> TelemetryDisplayEvent.ToolCall(
            timestamp = timestamp, toolName = toolName ?: "unknown", durationMs = durationMs ?: 0,
            success = success ?: true, error = error,
        )
        "accessibility" -> TelemetryDisplayEvent.Accessibility(
            timestamp = timestamp, packageName = packageName ?: "unknown",
            screenId = screenId ?: "", totalViolations = totalViolations ?: 0,
            newViolations = newViolations ?: 0, baselinedCount = baselinedCount ?: 0,
            violations = emptyList(),
        )
        "memory" -> TelemetryDisplayEvent.Memory(
            timestamp = timestamp, packageName = packageName ?: "unknown", passed = passed ?: true,
            javaHeapGrowthMb = javaHeapGrowthMb, nativeHeapGrowthMb = nativeHeapGrowthMb,
            gcCount = gcCount, gcDurationMs = gcDurationMs, unreachableObjects = unreachableObjects,
            violations = violations ?: emptyList(),
        )
        "performance" -> TelemetryDisplayEvent.Performance(
            timestamp = timestamp, fps = fps, frameTimeMs = frameTimeMs, jankFrames = jankFrames,
            touchLatencyMs = touchLatencyMs, memoryUsageMb = memoryUsageMb,
            cpuUsagePercent = cpuUsagePercent, health = health ?: "healthy",
            changedMetrics = changedMetrics ?: emptyList(),
        )
        "layout" -> TelemetryDisplayEvent.Layout(
            timestamp = timestamp, subType = subType ?: "unknown", composableName = composableName,
            recompositionCount = recompositionCount, durationMs = durationMs, likelyCause = likelyCause,
            screenName = screenName, detailsJson = detailsJson,
        )
        else -> null
    }
}
