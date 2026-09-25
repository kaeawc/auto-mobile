package dev.jasonpearson.automobile.desktop.core.telemetry

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

private val LOG = LoggerFactory.getLogger("LogsSavedViews")

/** A named, global Logs filter. A blank tag disables the tag predicate. */
@Serializable
data class LogsSavedView(
  val name: String,
  val enabledLevels: Set<LogLevel>,
  val tag: String?,
  val query: String,
)

/** Search matches message or tag; the optional tag predicate narrows that result independently. */
fun matchesSavedView(
  log: TelemetryDisplayEvent.Log,
  view: LogsSavedView,
  platform: LogPlatform = LogPlatform.Android,
): Boolean =
  logLevelOf(log.level, platform) in view.enabledLevels &&
    (view.tag.isNullOrBlank() || log.tag.contains(view.tag.orEmpty(), ignoreCase = true)) &&
    (view.query.isBlank() ||
      log.message.contains(view.query, ignoreCase = true) ||
      log.tag.contains(view.query, ignoreCase = true))

fun serializeLogsSavedViews(views: List<LogsSavedView>): String = Json.encodeToString(views)

fun deserializeLogsSavedViews(json: String): List<LogsSavedView> {
  if (json.isBlank()) return emptyList()
  return try {
    Json.decodeFromString<List<LogsSavedView>>(json)
  } catch (error: SerializationException) {
    // Malformed user settings are recoverable; an empty list keeps the Logs facet usable.
    LOG.debug("Ignoring malformed saved Logs views: ${error.message}")
    emptyList()
  } catch (error: IllegalArgumentException) {
    // Invalid serialized values are recoverable just like malformed JSON.
    LOG.debug("Ignoring invalid saved Logs views: ${error.message}")
    emptyList()
  }
}
