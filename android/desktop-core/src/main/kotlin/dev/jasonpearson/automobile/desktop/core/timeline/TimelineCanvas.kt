@file:OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.timeline

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.input.pointer.PointerEvent
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.isCtrlPressed
import androidx.compose.ui.input.pointer.isMetaPressed
import androidx.compose.ui.input.pointer.onPointerEvent
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs

private val IS_MAC = System.getProperty("os.name", "").contains("Mac", ignoreCase = true)

private fun PointerEvent.isZoomModifierPressed(): Boolean =
  if (IS_MAC) keyboardModifiers.isMetaPressed else keyboardModifiers.isCtrlPressed

private const val TIME_AXIS_HEIGHT = 16f
private const val LANE_LABEL_WIDTH = 48f
private const val LABEL_PADDING = 8f
private const val SPAN_HEIGHT_FRACTION = 0.6f
private const val MIN_SPAN_WIDTH_PX = 2f
private const val CORNER_RADIUS = 2f
private const val PLAYHEAD_WIDTH = 1.5f
private const val CLICK_TOLERANCE_MS = 5L

private val laneLabels: Map<Int, String> by lazy {
  TimelineCategory.entries
    .groupBy { it.laneIndex }
    .mapValues { (_, cats) -> cats.joinToString("/") { it.label } }
}

// SimpleDateFormat is not thread-safe; use ThreadLocal to avoid races across compositions.
private val timeFormat = ThreadLocal.withInitial { SimpleDateFormat("HH:mm:ss", Locale.US) }

@Composable
fun TimelineCanvas(
  spans: List<TimelineSpan>,
  activeLanes: List<Int>,
  state: TimelineState,
  onEventClicked: (TelemetryDisplayEvent) -> Unit,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  val textColor = colors.text.normal
  val panelBg = colors.panelBackground
  val infoColor = colors.text.info
  val textMeasurer = rememberTextMeasurer()

  Box(
    modifier =
      modifier
        .onPointerEvent(PointerEventType.Scroll) { event ->
          val change = event.changes.firstOrNull() ?: return@onPointerEvent
          if (event.isZoomModifierPressed()) {
            val chartWidth = (size.width - LANE_LABEL_WIDTH).coerceAtLeast(1f)
            val pivotFraction = (change.position.x - LANE_LABEL_WIDTH) / chartWidth
            state.scrollZoom(change.scrollDelta.y, pivotFraction.coerceIn(0f, 1f))
            change.consume()
          }
        }
        .pointerInput(Unit) {
          detectDragGestures { _, dragAmount ->
            state.panBy(-dragAmount.x / size.width.toFloat())
          }
        }
        .pointerInput(spans, state) {
          detectTapGestures { offset ->
            val fraction = offset.x / size.width.toFloat()
            val clickedTimestamp = state.fractionToTimestamp(fraction)
            state.selectedTimestampMs = clickedTimestamp

            val nearest =
              spans
                .filter { span ->
                  val startFrac = state.timestampToFraction(span.startMs)
                  val endFrac = state.timestampToFraction(span.endMs)
                  val startX = startFrac * size.width
                  val rawEndX = endFrac * size.width
                  val endX =
                    if (rawEndX - startX < MIN_SPAN_WIDTH_PX) startX + MIN_SPAN_WIDTH_PX
                    else rawEndX
                  offset.x in startX..endX
                }
                .minByOrNull { abs(it.startMs - clickedTimestamp) }
                ?: spans
                  .minByOrNull {
                    minOf(
                      abs(it.startMs - clickedTimestamp),
                      abs(it.endMs - clickedTimestamp),
                    )
                  }
                  ?.takeIf {
                    minOf(
                      abs(it.startMs - clickedTimestamp),
                      abs(it.endMs - clickedTimestamp),
                    ) <= CLICK_TOLERANCE_MS
                  }

            if (nearest != null) {
              onEventClicked(nearest.event)
            }
          }
        }
  ) {
    Canvas(modifier = Modifier.fillMaxSize()) {
      val canvasWidth = size.width
      val canvasHeight = size.height
      val drawableHeight = canvasHeight - TIME_AXIS_HEIGHT
      val laneCount = activeLanes.size.coerceAtLeast(1)
      val laneHeight = drawableHeight / laneCount

      // Lane backgrounds
      activeLanes.forEachIndexed { index, _ ->
        val y = index * laneHeight
        val alpha = if (index % 2 == 0) 0.03f else 0.06f
        drawRect(
          color = panelBg,
          topLeft = Offset(0f, y),
          size = Size(canvasWidth, laneHeight),
          alpha = alpha,
        )
      }

      // Lane labels
      val labelStyle = TextStyle(fontSize = 9.sp, color = textColor.copy(alpha = 0.4f))
      activeLanes.forEachIndexed { index, laneIndex ->
        val y = index * laneHeight
        val label = laneLabels[laneIndex] ?: ""
        val measured = textMeasurer.measure(label, labelStyle)
        drawText(
          textLayoutResult = measured,
          topLeft = Offset(LABEL_PADDING, y + (laneHeight - measured.size.height) / 2f),
        )
      }

      val laneToRow = activeLanes.withIndex().associate { (row, lane) -> lane to row }

      for (span in spans) {
        val row = laneToRow[span.category.laneIndex] ?: continue
        val startFrac = state.timestampToFraction(span.startMs)
        val endFrac = state.timestampToFraction(span.endMs)
        val x1 = startFrac * canvasWidth
        val x2Raw = endFrac * canvasWidth
        val x2 = if (x2Raw - x1 < MIN_SPAN_WIDTH_PX) x1 + MIN_SPAN_WIDTH_PX else x2Raw

        val rowY = row * laneHeight
        val spanH = laneHeight * SPAN_HEIGHT_FRACTION
        val spanY = rowY + (laneHeight - spanH) / 2f
        val alpha = if (span.isFiltered) 0.2f else 1.0f

        drawRoundRect(
          color = span.category.color,
          topLeft = Offset(x1, spanY),
          size = Size(x2 - x1, spanH),
          cornerRadius = CornerRadius(CORNER_RADIUS, CORNER_RADIUS),
          alpha = alpha,
        )
      }

      // Time axis
      drawTimeAxis(
        canvasWidth = canvasWidth,
        canvasHeight = canvasHeight,
        state = state,
        textMeasurer = textMeasurer,
        textColor = textColor,
      )

      // Playhead
      val selectedMs = state.selectedTimestampMs
      if (selectedMs != null) {
        val frac = state.timestampToFraction(selectedMs)
        val x = frac * canvasWidth
        drawLine(
          color = infoColor.copy(alpha = 0.8f),
          start = Offset(x, 0f),
          end = Offset(x, canvasHeight),
          strokeWidth = PLAYHEAD_WIDTH,
        )
      }
    }
  }
}

private fun DrawScope.drawTimeAxis(
  canvasWidth: Float,
  canvasHeight: Float,
  state: TimelineState,
  textMeasurer: TextMeasurer,
  textColor: Color,
) {
  val axisY = canvasHeight - TIME_AXIS_HEIGHT
  val duration = state.visibleDurationMs()

  // Choose a tick interval that gives roughly 6-10 ticks
  val rawInterval = duration / 8.0
  val tickIntervalMs = snapToNiceInterval(rawInterval)
  if (tickIntervalMs <= 0) return

  val firstTick = ((state.visibleStartMs / tickIntervalMs) + 1) * tickIntervalMs
  val tickStyle = TextStyle(fontSize = 9.sp, color = textColor.copy(alpha = 0.4f))
  var tick = firstTick

  while (tick <= state.visibleEndMs) {
    val frac = state.timestampToFraction(tick)
    val x = frac * canvasWidth

    // Tick mark
    drawLine(
      color = textColor.copy(alpha = 0.2f),
      start = Offset(x, axisY),
      end = Offset(x, axisY + 4f),
      strokeWidth = 1f,
    )

    // Time label
    val label = timeFormat.get().format(Date(tick))
    val measured = textMeasurer.measure(label, tickStyle)
    drawText(
      textLayoutResult = measured,
      topLeft = Offset(x - measured.size.width / 2f, axisY + 4f),
    )

    tick += tickIntervalMs
  }
}

private fun snapToNiceInterval(rawMs: Double): Long {
  val nice =
    longArrayOf(
      100,
      200,
      500,
      1_000,
      2_000,
      5_000,
      10_000,
      15_000,
      30_000,
      60_000,
      120_000,
      300_000,
      600_000,
      900_000,
      1_800_000,
      3_600_000,
      7_200_000,
      14_400_000,
      28_800_000,
      86_400_000,
    )
  return nice.firstOrNull { it >= rawMs } ?: nice.last()
}
