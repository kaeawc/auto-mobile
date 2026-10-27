package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.util.Calendar
import java.util.GregorianCalendar
import java.util.TimeZone
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/** Strict ISO calendar parsing without java.time (the renderer supports API 24). */
internal object PrototypeFormatTime {
  private val iso =
    Regex(
      "^(\\d{4})-(\\d{2})-(\\d{2})(?:T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d+))?(Z|[+-]\\d{2}:\\d{2}))?$",
    )
  private val units =
    listOf(
      31536000000L to "year",
      2592000000L to "month",
      86400000L to "day",
      3600000L to "hour",
      60000L to "minute",
      1000L to "second",
    )

  fun relativeUnit(diff: Long): Pair<Long, String> =
    units.firstOrNull { kotlin.math.abs(diff) >= it.first } ?: units.last()

  fun epoch(input: JsonElement?): Long? {
    val primitive = input as? JsonPrimitive ?: return null
    if (!primitive.isString) return numericEpoch(primitive)
    return parseIso(primitive.content)
  }

  private fun numericEpoch(input: JsonPrimitive): Long? {
    val number = input.doubleOrNull ?: return null
    return number
      .takeIf { it.isFinite() && it % 1.0 == 0.0 && kotlin.math.abs(it) <= 8640000000000000.0 }
      ?.toLong()
  }

  private fun parseIso(text: String): Long? {
    val match = iso.matchEntire(text) ?: return null
    val parts = match.groupValues
    val zone = parts[8]
    var offset = 0
    if (zone.isNotEmpty() && zone != "Z") {
      val hours = zone.substring(1, 3).toInt()
      val minutes = zone.substring(4, 6).toInt()
      if (hours > 23 || minutes > 59) return null
      offset = (hours * 60 + minutes) * 60000 * if (zone[0] == '-') -1 else 1
    }
    return try {
      val calendar =
        GregorianCalendar(TimeZone.getTimeZone("UTC")).apply {
          gregorianChange = java.util.Date(Long.MIN_VALUE)
          isLenient = false
          clear()
          val year = parts[1].toInt()
          set(Calendar.ERA, if (year == 0) GregorianCalendar.BC else GregorianCalendar.AD)
          set(Calendar.YEAR, if (year == 0) 1 else year)
          set(Calendar.MONTH, parts[2].toInt() - 1)
          set(Calendar.DAY_OF_MONTH, parts[3].toInt())
          set(Calendar.HOUR_OF_DAY, parts[4].toIntOrNull() ?: 0)
          set(Calendar.MINUTE, parts[5].toIntOrNull() ?: 0)
          set(Calendar.SECOND, parts[6].toIntOrNull() ?: 0)
          set(Calendar.MILLISECOND, parts[7].take(3).padEnd(3, '0').toInt())
        }
      calendar.timeInMillis - offset
    } catch (_: IllegalArgumentException) {
      // Calendar overflow and invalid clock components are expected authored input failures.
      null
    }
  }
}
