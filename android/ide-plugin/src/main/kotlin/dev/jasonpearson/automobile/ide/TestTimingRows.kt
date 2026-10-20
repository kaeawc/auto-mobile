package dev.jasonpearson.automobile.ide

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.daemon.TestTimingEntry
import org.jetbrains.jewel.ui.component.Text

@Composable
internal fun HeaderCell(text: String, modifier: Modifier, palette: TestTimingPalette) {
  Text(
    text = text,
    color = palette.labelMuted,
    fontSize = 11.sp,
    maxLines = 1,
    overflow = TextOverflow.Ellipsis,
    modifier = modifier,
  )
}

@Composable
internal fun TestTimingRow(
  entry: TestTimingEntry,
  maxDuration: Int,
  palette: TestTimingPalette,
  onOpen: () -> Unit,
) {
  val durationRatio =
    if (maxDuration > 0) {
      (entry.averageDurationMs.toFloat() / maxDuration.toFloat()).coerceIn(0f, 1f)
    } else {
      0f
    }
  val successColor =
    when {
      entry.successRate < 0.9 -> palette.error
      entry.successRate < 0.97 -> palette.warning
      else -> Color.Unspecified
    }

  Row(
    modifier = Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(vertical = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Text(
      text = "${entry.testClass}.${entry.testMethod}",
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.weight(TEST_COL_WEIGHT),
    )
    Column(modifier = Modifier.weight(AVG_COL_WEIGHT)) {
      Text(formatDuration(entry.averageDurationMs), fontSize = 12.sp)
      Spacer(modifier = Modifier.height(4.dp))
      Row(modifier = Modifier.fillMaxWidth().height(6.dp).background(palette.barTrack)) {
        Spacer(modifier = Modifier.fillMaxWidth(durationRatio).background(palette.barFill))
      }
    }
    Text(
      text = entry.sampleSize.toString(),
      modifier = Modifier.weight(RUNS_COL_WEIGHT),
    )
    Text(
      text = formatRate(entry.successRate),
      color = successColor,
      modifier = Modifier.weight(SUCCESS_COL_WEIGHT),
    )
    Text(
      text = formatTimestamp(entry.lastRun),
      modifier = Modifier.weight(LAST_RUN_COL_WEIGHT),
    )
  }
}
