package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.Immutable
import dev.jasonpearson.automobile.protocol.PrototypeChartNode
import dev.jasonpearson.automobile.protocol.PrototypeDataPointer
import dev.jasonpearson.automobile.protocol.PrototypeModeValue
import java.math.BigDecimal
import java.math.RoundingMode
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/** One drawn point: its `x` label, if the series names an `x` member, and its `y` value. */
@Immutable data class PrototypeChartPoint(val x: String?, val y: Double)

@Immutable
data class PrototypeChartSeriesModel(
  val label: String,
  val points: List<PrototypeChartPoint>,
  val color: PrototypeModeValue?,
)

/**
 * A `chart` node read against the current `/data` (#14209): its series' points, the y axis it is
 * drawn over, and the accessible [summary] that `observe` reports as its label.
 */
@Immutable
data class PrototypeChartModel(
  val variant: String,
  val series: List<PrototypeChartSeriesModel>,
  val yMin: Double,
  val yMax: Double,
  val goal: Double?,
  val xLabels: String,
  val summary: String,
)

internal object PrototypeChart {
  /**
   * The chart's points read from [data]. A point that is not an object or whose `y` is not a finite
   * number is skipped: validation rejects them in the shown spec, but a later `/data` write may
   * not.
   */
  fun model(node: PrototypeChartNode, data: JsonObject?): PrototypeChartModel {
    val series =
      node.series.map { series ->
        val points =
          (PrototypeDataPointer.resolve(data, series.path) as? JsonArray).orEmpty().mapNotNull {
            val point = it as? JsonObject ?: return@mapNotNull null
            val y = number(point[series.y]) ?: return@mapNotNull null
            PrototypeChartPoint(series.x?.let { x -> label(point[x]) }, y)
          }
        PrototypeChartSeriesModel(series.label, points, series.color)
      }
    val (min, max) = node.yRange?.let { it.min to it.max } ?: autoRange(node, series)
    return PrototypeChartModel(
      node.variant,
      series,
      min,
      max,
      node.goal,
      node.xLabels,
      summary(node.variant, series, node.goal),
    )
  }

  /** The drawn y range: the values and goal, with bars rising from zero, never empty. */
  private fun autoRange(
    node: PrototypeChartNode,
    series: List<PrototypeChartSeriesModel>,
  ): Pair<Double, Double> {
    val values = series.flatMap { it.points.map(PrototypeChartPoint::y) } + listOfNotNull(node.goal)
    val withBase = if (node.variant == "bar") values + 0.0 else values
    val low = withBase.minOrNull() ?: 0.0
    val high = withBase.maxOrNull() ?: 1.0
    return if (high > low) low to high else (low - 1) to (high + 1)
  }

  /** "Line chart, Heart rate, 24 points, min 58, max 141, latest 72"; a ring reads its goal. */
  fun summary(variant: String, series: List<PrototypeChartSeriesModel>, goal: Double?): String {
    val kind = "${variant.replaceFirstChar(Char::uppercaseChar)} chart"
    if (variant == "ring") {
      val only = series.firstOrNull()
      val latest = only?.points?.lastOrNull()?.y ?: 0.0
      return "$kind, ${only?.label.orEmpty()}, ${format(latest)} of ${goal?.let(::format) ?: "0"}"
    }
    val parts = series.map { entry ->
      val ys = entry.points.map(PrototypeChartPoint::y)
      if (ys.isEmpty()) "${entry.label}, no points"
      else
        "${entry.label}, ${ys.size} ${if (ys.size == 1) "point" else "points"}, " +
          "min ${format(ys.min())}, max ${format(ys.max())}, latest ${format(ys.last())}"
    }
    val goalPart = goal?.let { ", goal ${format(it)}" }.orEmpty()
    return "$kind, ${parts.joinToString("; ")}$goalPart"
  }

  /** At most two decimals, without trailing zeros: 72, 72.5, 0.33. */
  fun format(value: Double): String =
    BigDecimal(value).setScale(2, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString().let {
      if (it == "-0") "0" else it
    }

  private fun number(element: Any?): Double? =
    (element as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull?.takeIf { it.isFinite() }

  private fun label(element: Any?): String? {
    val primitive = element as? JsonPrimitive ?: return null
    return if (primitive.isString) primitive.content else number(primitive)?.let(::format)
  }
}
