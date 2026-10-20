package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import kotlinx.coroutines.flow.filter

/** Merge each pane's mutation against the provider's latest persisted value. */
internal fun mutateLogsSavedViews(
  settingsProvider: SettingsProvider,
  transform: (List<LogsSavedView>) -> List<LogsSavedView>,
): List<LogsSavedView> {
  val updated = transform(deserializeLogsSavedViews(settingsProvider.logsSavedViews))
  settingsProvider.logsSavedViews = serializeLogsSavedViews(updated)
  return updated
}

fun isAutoMobileInternalTag(tag: String): Boolean = tag in AUTO_MOBILE_INTERNAL_TAGS

internal fun defaultEnabledLevels(minimum: LogLevel?): Set<LogLevel> =
  LogLevel.entries.filter { it.ordinal >= (minimum ?: LogLevel.Info).ordinal }.toSet()

/**
 * Maps a raw log-priority int to its [LogLevel] bucket for the given [platform]. Every int maps to
 * exactly one bucket so that "all chips enabled" is a true no-op filter.
 *
 * Android uses `Log.VERBOSE`=2 .. `Log.ASSERT`=7; iOS's `LogLevel` uses `verbose`=0 .. `fault`=5
 * (see `ios/auto-mobile-sdk/.../Events/SdkEvent.swift`). Both fold their top severities (Android
 * Assert, iOS Fault) into [Error], and unknown/low priorities into [Verbose].
 */
fun logLevelOf(level: Int, platform: LogPlatform = LogPlatform.Android): LogLevel =
  when (platform) {
    LogPlatform.Android ->
      when {
        level <= 2 -> LogLevel.Verbose
        level == 3 -> LogLevel.Debug
        level == 4 -> LogLevel.Info
        level == 5 -> LogLevel.Warn
        else -> LogLevel.Error
      }
    LogPlatform.Ios ->
      when {
        level <= 0 -> LogLevel.Verbose
        level == 1 -> LogLevel.Debug
        level == 2 -> LogLevel.Info
        level == 3 -> LogLevel.Warn
        else -> LogLevel.Error // 4 = error, 5 = fault
      }
  }

/**
 * Client-side filter over already-streamed log rows. A row survives when its [LogLevel] (bucketed
 * for [platform]) is in [enabledLevels], its tag matches [tag] when set, and its message or tag
 * matches [query]. Both text predicates use case-insensitive substring matching.
 */
fun filterLogs(
  logs: List<TelemetryDisplayEvent.Log>,
  options: LogFilter,
): List<TelemetryDisplayEvent.Log> {
  with(options) {
    val filter = LogsSavedView("", enabledLevels, tag, query)
    return logs.filter {
      (showInternalTags || !isAutoMobileInternalTag(it.tag)) &&
        matchesSavedView(it, filter, platform)
    }
  }
}

/**
 * Whether a scroll delta should clear the panel's tail-follow intent. True only for a **user**
 * scroll ([NestedScrollSource.UserInput] — touch drag or mouse wheel) moving toward older rows
 * (positive `y`, i.e. content moving down / away from the tail).
 *
 * Deliberately excludes the panel's own programmatic re-anchor scrolls, which dispatch as
 * [NestedScrollSource.SideEffect]: the upward `scrollToItem` after a filter narrows the list must
 * not be mistaken for the user scrolling away, or tail-follow would defeat itself. Kept pure so the
 * discrimination is unit-testable without Compose.
 */
fun clearsTailFollow(available: Offset, source: NestedScrollSource): Boolean =
  source == NestedScrollSource.UserInput && available.y > 0f

/**
 * Appends [event] to [logs] with ring-buffer semantics: once the buffer exceeds [max] the oldest
 * rows are dropped, so only the most recent [max] rows are retained. Kept pure (operates on any
 * [MutableList]) so the bound is unit-testable without Compose.
 */
fun appendBounded(
  logs: MutableList<TelemetryDisplayEvent.Log>,
  event: TelemetryDisplayEvent.Log,
  max: Int = MAX_LOG_ROWS,
) {
  logs.add(event)
  while (logs.size > max) {
    logs.removeAt(0)
  }
}

/**
 * Human-readable status for a non-healthy telemetry [ConnectionState], or `null` when
 * [ConnectionState.Connected] (nothing to surface). Pure so the mapping is unit-testable and the
 * panel never mislabels a connecting/errored socket as an empty-but-healthy stream.
 */
fun connectionStatusText(state: ConnectionState): String? =
  when (state) {
    is ConnectionState.Connecting -> "Connecting..."
    is ConnectionState.Reconnecting -> "Reconnecting (attempt ${state.attempt})..."
    is ConnectionState.Disconnected -> "Disconnected" + (state.reason?.let { ": $it" } ?: "")
    is ConnectionState.Error -> "Error: ${state.message}"
    is ConnectionState.Connected -> null
  }
