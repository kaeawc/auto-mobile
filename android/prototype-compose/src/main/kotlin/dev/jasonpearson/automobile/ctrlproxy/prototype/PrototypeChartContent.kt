package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

private val CHART_HEIGHT = 160.dp
private val RING_SIZE = 120.dp
private const val AREA_ALPHA = 0.25f
private const val BAR_FILL = 0.7f
private const val FULL_SWEEP = 360f
private const val TOP_ANGLE = -90f

/** The default series colours, in order, when a series names no `color`. */
private fun seriesColor(scheme: ColorScheme, index: Int): Color =
  listOf(scheme.primary, scheme.tertiary, scheme.secondary, scheme.error)[index % 4]

/**
 * A `chart` (#14209) drawn with Compose [Canvas], with no charting dependency: lines, filled areas,
 * grouped bars, or a ring of the latest value against the goal. The node's label is the chart's
 * summary (see [PrototypeChart.summary]); the x labels below it are visual only.
 */
@Composable
internal fun RenderPrototypeChart(node: PrototypeRenderNode, modifier: Modifier) {
  val chart = node.chart ?: return
  val scheme = MaterialTheme.colorScheme
  val colors =
    chart.series.mapIndexed { index, series ->
      prototypeThemedColor(null, series.color) ?: seriesColor(scheme, index)
    }
  if (chart.variant == "ring") {
    val latest = chart.series.firstOrNull()?.points?.lastOrNull()?.y ?: 0.0
    val fraction = (latest / (chart.goal ?: 1.0)).coerceIn(0.0, 1.0).toFloat()
    Canvas(modifier.size(RING_SIZE)) { drawRing(fraction, colors.first(), scheme.surfaceVariant) }
    return
  }
  Column(modifier.fillMaxWidth()) {
    Canvas(Modifier.fillMaxWidth().height(CHART_HEIGHT)) {
      val scale = ChartScale(size, chart.yMin, chart.yMax)
      chart.goal?.let { drawGoal(scale.y(it), scheme.outline) }
      if (chart.variant == "bar") drawBars(chart, colors, scale)
      else
        chart.series.forEachIndexed { index, series ->
          drawLine(series.points.map { it.y }, colors[index], scale, chart.variant == "area")
        }
    }
    ChartXLabels(chart)
  }
}

private class ChartScale(val size: Size, private val min: Double, private val max: Double) {
  fun y(value: Double): Float =
    size.height - ((value - min) / (max - min)).coerceIn(0.0, 1.0).toFloat() * size.height

  /** A point's x centre: the full width for a line, evenly spaced slots otherwise. */
  fun x(index: Int, count: Int): Float =
    if (count <= 1) size.width / 2 else index * size.width / (count - 1)
}

private fun DrawScope.drawGoal(y: Float, color: Color) {
  val dash = 6.dp.toPx()
  drawLine(
    color,
    Offset(0f, y),
    Offset(size.width, y),
    strokeWidth = 1.dp.toPx(),
    pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, dash)),
  )
}

private fun DrawScope.drawLine(ys: List<Double>, color: Color, scale: ChartScale, fill: Boolean) {
  if (ys.isEmpty()) return
  val points = ys.mapIndexed { index, y -> Offset(scale.x(index, ys.size), scale.y(y)) }
  val line =
    Path().apply {
      moveTo(points.first().x, points.first().y)
      points.drop(1).forEach { lineTo(it.x, it.y) }
    }
  if (fill) {
    val area =
      Path().apply {
        addPath(line)
        lineTo(points.last().x, size.height)
        lineTo(points.first().x, size.height)
        close()
      }
    drawPath(area, color.copy(alpha = AREA_ALPHA))
  }
  drawPath(line, color, style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round))
}

/** Grouped bars: one slot per point index, one bar per series within it, rising from zero. */
private fun DrawScope.drawBars(chart: PrototypeChartModel, colors: List<Color>, scale: ChartScale) {
  val slots = chart.series.maxOfOrNull { it.points.size } ?: 0
  if (slots == 0) return
  val slot = size.width / slots
  val bar = slot * BAR_FILL / chart.series.size
  val base = scale.y(0.0.coerceIn(chart.yMin, chart.yMax))
  val radius = CornerRadius(2.dp.toPx())
  chart.series.forEachIndexed { index, series ->
    series.points.forEachIndexed { slotIndex, point ->
      val top = scale.y(point.y)
      val left = slotIndex * slot + slot * (1 - BAR_FILL) / 2 + index * bar
      drawRoundRect(
        colors[index],
        Offset(left, minOf(top, base)),
        Size(bar, kotlin.math.abs(base - top)),
        radius,
      )
    }
  }
}

private fun DrawScope.drawRing(fraction: Float, color: Color, track: Color) {
  val stroke = 12.dp.toPx()
  val inset = stroke / 2
  val arc = Size(size.width - stroke, size.height - stroke)
  val style = Stroke(width = stroke, cap = StrokeCap.Round)
  drawArc(track, 0f, FULL_SWEEP, false, Offset(inset, inset), arc, style = style)
  drawArc(color, TOP_ANGLE, FULL_SWEEP * fraction, false, Offset(inset, inset), arc, style = style)
}

/** The first series' x labels: none, the two ends, or all of them evenly spaced. */
@Composable
private fun ChartXLabels(chart: PrototypeChartModel) {
  val labels = chart.series.firstOrNull()?.points?.mapNotNull { it.x }.orEmpty()
  val shown =
    when (chart.xLabels) {
      "all" -> labels
      "ends" -> if (labels.size > 1) listOf(labels.first(), labels.last()) else labels
      else -> emptyList()
    }
  if (shown.isEmpty()) return
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
    shown.forEach {
      Text(
        it,
        Modifier.clearAndSetSemantics {},
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
  }
}
