package dev.jasonpearson.automobile.desktop.core.telemetry

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
      } catch (error: java.util.regex.PatternSyntaxException) {
        dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory.getLogger("Telemetry")
          .debug("Invalid search pattern: ${error.message}")
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
    is TelemetryDisplayEvent.Network -> anyNetworkField(predicate)
    is TelemetryDisplayEvent.Log -> anyLogField(predicate)
    is TelemetryDisplayEvent.Navigation -> anyNavigationField(predicate)
    is TelemetryDisplayEvent.Os -> anyOsField(predicate)
    is TelemetryDisplayEvent.Failure -> anyFailureField(predicate)
    is TelemetryDisplayEvent.Storage -> anyStorageField(predicate)
    is TelemetryDisplayEvent.Layout -> anyLayoutField(predicate)
    is TelemetryDisplayEvent.Performance -> anyPerformanceField(predicate)
    is TelemetryDisplayEvent.ToolCall -> anyToolCallField(predicate)
    is TelemetryDisplayEvent.Accessibility -> anyAccessibilityField(predicate)
    is TelemetryDisplayEvent.Memory -> anyMemoryField(predicate)
  }

private inline fun TelemetryDisplayEvent.Memory.anyMemoryField(
  predicate: (String) -> Boolean,
): Boolean = predicate(packageName) || violations.any(predicate) || predicate("memory")

private inline fun TelemetryDisplayEvent.Accessibility.anyAccessibilityField(
  predicate: (String) -> Boolean,
): Boolean =
  predicate(packageName) ||
    predicate(screenId) ||
    violations.any { predicate(it.type) || predicate(it.message) }

private inline fun TelemetryDisplayEvent.ToolCall.anyToolCallField(
  predicate: (String) -> Boolean,
): Boolean = predicate(toolName) || error?.let(predicate) == true

private inline fun TelemetryDisplayEvent.Performance.anyPerformanceField(
  predicate: (String) -> Boolean,
): Boolean = predicate(health) || changedMetrics.any(predicate) || predicate("performance")

private inline fun TelemetryDisplayEvent.Layout.anyLayoutField(
  predicate: (String) -> Boolean,
): Boolean =
  predicate(subType) ||
    composableName?.let(predicate) == true ||
    screenName?.let(predicate) == true ||
    likelyCause?.let(predicate) == true
