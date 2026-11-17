package dev.jasonpearson.automobile.ctrlproxy.prototype

import kotlin.math.roundToInt
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Android readings mapped to the shared device-status contract, without framework dependencies. */
object PrototypeDeviceStatus {
  fun batteryState(status: Int): String =
    when (status) {
      2 -> "charging"
      3,
      4 -> "unplugged"
      5 -> "full"
      else -> "unknown"
    }

  fun percent(value: Double, maximum: Double): Int? =
    if (hasFiniteInputs(value, maximum) && value >= 0 && maximum > 0)
      (value / maximum * 100).coerceIn(0.0, 100.0).roundToInt()
    else null

  private fun hasFiniteInputs(value: Double, maximum: Double): Boolean =
    value.isFinite() && maximum.isFinite()

  fun thermal(status: Double): String? =
    when (status) {
      0.0 -> "nominal"
      1.0,
      2.0 -> "fair"
      3.0 -> "serious"
      4.0,
      5.0,
      6.0 -> "critical"
      else -> null
    }

  fun ringer(mode: Int): String? =
    when (mode) {
      0 -> "silent"
      1 -> "vibrate"
      2 -> "normal"
      else -> null
    }

  fun battery(level: Int, scale: Int, status: Int): JsonObject = buildJsonObject {
    percent(level.toDouble(), scale.toDouble())?.let { put("level", it) }
    put("state", batteryState(status))
  }

  fun power(saver: Boolean, thermalStatus: Int?): JsonObject = buildJsonObject {
    put("saver", saver)
    thermalStatus?.let { thermal(it.toDouble()) }?.let { put("thermal", it) }
  }

  fun audio(reading: AudioStatusReading): JsonObject = buildJsonObject {
    percent(reading.volume.toDouble(), reading.maximum.toDouble())?.let { put("volume", it) }
    put("muted", reading.volume == 0 || reading.muted)
    put("route", audioRoute(reading.outputs))
    ringer(reading.ringer)?.let { put("ringer", it) }
  }

  /** Prefer external outputs to the built-in speaker when Android reports both as available. */
  fun audioRoute(outputs: Set<String>): String =
    listOf("bluetooth", "wired", "usb", "speaker").firstOrNull { it in outputs } ?: "other"
}

data class AudioStatusReading(
  val volume: Int,
  val maximum: Int,
  val muted: Boolean,
  val outputs: Set<String>,
  val ringer: Int,
)
