package dev.jasonpearson.automobile.ide

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import dev.jasonpearson.automobile.desktop.core.daemon.TestTimingEntry
import dev.jasonpearson.automobile.desktop.core.daemon.TestTimingOrderBy
import dev.jasonpearson.automobile.desktop.core.daemon.TestTimingOrderDirection
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import org.jetbrains.jewel.foundation.theme.JewelTheme

internal fun buildTestTimingComparator(
  key: TestTimingSortKey,
  direction: TestTimingSortDirection,
): Comparator<TestTimingEntry> {
  val comparator =
    when (key) {
      TestTimingSortKey.NAME ->
        compareBy<TestTimingEntry> { it.testClass.lowercase() }.thenBy { it.testMethod.lowercase() }
      TestTimingSortKey.AVG_DURATION ->
        compareBy<TestTimingEntry> { it.averageDurationMs }.thenBy { it.testClass.lowercase() }
      TestTimingSortKey.SAMPLE_SIZE ->
        compareBy<TestTimingEntry> { it.sampleSize }.thenBy { it.testClass.lowercase() }
      TestTimingSortKey.LAST_RUN ->
        compareBy<TestTimingEntry> { it.lastRunTimestampMs ?: 0L }
          .thenBy { it.testClass.lowercase() }
    }

  return if (direction == TestTimingSortDirection.DESC) comparator.reversed() else comparator
}

internal fun TestTimingSortKey.toOrderByOrNull(): TestTimingOrderBy? =
  when (this) {
    TestTimingSortKey.AVG_DURATION -> TestTimingOrderBy.AVERAGE_DURATION
    TestTimingSortKey.SAMPLE_SIZE -> TestTimingOrderBy.SAMPLE_SIZE
    TestTimingSortKey.LAST_RUN -> TestTimingOrderBy.LAST_RUN
    TestTimingSortKey.NAME -> null
  }

internal fun TestTimingSortDirection.toOrderDirection(): TestTimingOrderDirection =
  if (this == TestTimingSortDirection.ASC) {
    TestTimingOrderDirection.ASC
  } else {
    TestTimingOrderDirection.DESC
  }

internal fun formatDuration(durationMs: Int): String {
  if (durationMs >= 1000) {
    return "${formatUiNumber("%.2f", durationMs / 1000.0)}s"
  }
  return "${durationMs}ms"
}

internal fun formatRate(rate: Double): String {
  return "${formatUiNumber("%.1f", rate * 100)}%"
}

internal fun formatTimestamp(value: String?): String {
  if (value.isNullOrBlank()) {
    return "-"
  }
  return try {
    val instant = Instant.parse(value)
    TIMESTAMP_FORMATTER.format(instant.atZone(ZoneId.systemDefault()))
  } catch (_: java.time.format.DateTimeParseException) {
    value
  }
}

internal data class TestTimingSortOption(val key: TestTimingSortKey, val label: String)

internal data class TestTimingDirectionOption(
  val direction: TestTimingSortDirection,
  val label: String,
)

internal enum class TestTimingSortKey {
  NAME,
  AVG_DURATION,
  SAMPLE_SIZE,
  LAST_RUN,
}

internal enum class TestTimingSortDirection {
  ASC,
  DESC,
}

internal data class TestTimingPalette(
  val barFill: Color,
  val barTrack: Color,
  val labelMuted: Color,
  val detailBackground: Color,
  val warning: Color,
  val error: Color,
)

@Composable
internal fun rememberTestTimingPalette(): TestTimingPalette {
  val globals = JewelTheme.globalColors
  return TestTimingPalette(
    barFill = globals.text.info.copy(alpha = 0.9f),
    barTrack = globals.outlines.focused.copy(alpha = 0.2f),
    labelMuted = globals.text.normal.copy(alpha = 0.65f),
    detailBackground = globals.panelBackground.copy(alpha = 0.65f),
    warning = globals.text.warning,
    error = globals.text.error,
  )
}

internal const val DEFAULT_LOOKBACK_DAYS = 90
internal const val DEFAULT_MIN_SAMPLES = 1
internal const val DEFAULT_LIMIT = 1000
internal const val TEST_COL_WEIGHT = 0.48f
internal const val AVG_COL_WEIGHT = 0.18f
internal const val RUNS_COL_WEIGHT = 0.08f
internal const val SUCCESS_COL_WEIGHT = 0.1f
internal const val LAST_RUN_COL_WEIGHT = 0.16f
internal val TIMESTAMP_FORMATTER: DateTimeFormatter =
  DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

internal fun formatStatusCounts(entry: TestTimingEntry): String {
  val counts = entry.statusCounts ?: return "-"
  return "P:${counts.passed} F:${counts.failed} S:${counts.skipped}"
}
