package dev.jasonpearson.automobile.protocol

import kotlin.math.exp
import kotlin.math.sqrt
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonPrimitive

/** Fixed keyframe motion values until motion tokens exist. */
object PrototypeKeyframeTiming {
  const val STANDARD_X1 = 0.2
  const val STANDARD_Y1 = 0.0
  const val STANDARD_X2 = 0.0
  const val STANDARD_Y2 = 1.0
  const val SPRING_DAMPING_RATIO = 0.8
  const val SPRING_STIFFNESS = 380.0
}

/** Pure deterministic segment sampler. Spring is a normalized damped ease, not a physics clock. */
fun keyframeValue(points: List<Pair<Double, Double>>, curve: String, fraction: Double): Double {
  require(points.size >= 2)
  if (fraction <= points.first().first) return points.first().second
  if (fraction >= points.last().first) return points.last().second
  val end = points.indexOfFirst { it.first >= fraction }
  val (a, av) = points[end - 1]
  val (b, bv) = points[end]
  val t = ((fraction - a) / (b - a)).coerceIn(0.0, 1.0)
  if (t == 0.0) return av
  if (t == 1.0) return bv
  val eased =
    when (curve) {
      "linear" -> t
      "spring" -> {
        val rate =
          sqrt(PrototypeKeyframeTiming.SPRING_STIFFNESS) *
            PrototypeKeyframeTiming.SPRING_DAMPING_RATIO
        (1 - (1 + rate * t) * exp(-rate * t)) / (1 - (1 + rate) * exp(-rate))
      }
      else -> {
        fun cubic(u: Double, p1: Double, p2: Double): Double =
          3 * (1 - u) * (1 - u) * u * p1 + 3 * (1 - u) * u * u * p2 + u * u * u
        var lo = 0.0
        var hi = 1.0
        repeat(32) {
          val mid = (lo + hi) / 2
          if (
            cubic(mid, PrototypeKeyframeTiming.STANDARD_X1, PrototypeKeyframeTiming.STANDARD_X2) < t
          )
            lo = mid
          else hi = mid
        }
        cubic(
          (lo + hi) / 2,
          PrototypeKeyframeTiming.STANDARD_Y1,
          PrototypeKeyframeTiming.STANDARD_Y2,
        )
      }
    }
  return av * (1 - eased) + bv * eased
}

fun prototypeKeyframePoints(track: JsonElement): List<Pair<Double, Double>> {
  val raw = (track as? JsonObject)?.get("points") ?: track
  return (raw as JsonArray).map { point ->
    val pair = point as JsonArray
    pair[0].jsonPrimitive.double to pair[1].jsonPrimitive.double
  }
}
