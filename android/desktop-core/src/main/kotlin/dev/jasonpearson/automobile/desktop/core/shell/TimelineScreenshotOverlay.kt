package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

private val thumbnailShape = RoundedCornerShape(4.dp)

/**
 * Positions screenshot placeholder thumbnails above corresponding navigation events
 * on the timeline, based on their timestamp within the visible time range.
 */
@Composable
fun TimelineScreenshotOverlay(
    screenshotEvents: List<TelemetryDisplayEvent.Navigation>,
    timelineState: TimelineState,
    onScreenshotClicked: (TelemetryDisplayEvent.Navigation) -> Unit,
    modifier: Modifier = Modifier,
) {
    val range = timelineState.visibleTimeRange
    if (range.isEmpty()) return

    val colors = SharedTheme.globalColors
    val selectedTs = timelineState.selectedEventTimestamp

    Box(modifier = modifier) {
        for (event in screenshotEvents) {
            if (event.timestamp !in range) continue

            val fraction = (event.timestamp - range.first).toFloat() /
                maxOf((range.last - range.first).toFloat(), 1f)
            val isSelected = selectedTs == event.timestamp

            Box(
                modifier = Modifier
                    .offset { IntOffset((fraction * 1000).toInt(), 0) }
                    .size(width = 48.dp, height = 80.dp)
                    .clip(thumbnailShape)
                    .background(Color(0xFF2A2A2A))
                    .then(
                        if (isSelected) {
                            Modifier.border(BorderStroke(2.dp, colors.outlines.focused), thumbnailShape)
                        } else {
                            Modifier.border(BorderStroke(1.dp, Color(0xFF555555)), thumbnailShape)
                        }
                    )
                    .clickable { onScreenshotClicked(event) },
                contentAlignment = Alignment.Center,
            ) {
                // TODO: Load real screenshots via NavigationScreenshotLoader
                Text(
                    text = "\uD83D\uDCF7",
                    fontSize = 16.sp,
                )
            }
        }
    }
}
