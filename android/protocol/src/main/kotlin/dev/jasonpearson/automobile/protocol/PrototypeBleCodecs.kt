package dev.jasonpearson.automobile.protocol

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64
import kotlin.math.roundToLong
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/**
 * BLE value codecs (#14266), the Kotlin twin of `src/features/prototype/prototypeBleCodecs.ts`.
 * Both replay `test/fixtures/prototype-spec/ble/codecs.json`.
 */
object PrototypeBleCodecs {
  /** ATT attribute values are at most 512 bytes. */
  const val MAX_VALUE_BYTES = 512

  val codecs: List<String> =
    listOf(
      "utf8",
      "hex",
      "base64",
      "uint8",
      "uint16le",
      "int16le",
      "uint32le",
      "float32le",
      "gatt.battery_level",
      "gatt.heart_rate_measurement",
    )

  /** `length` and `range` are about the bytes or number; `format` is a value of the wrong shape. */
  enum class Error(val wireValue: String) {
    UNKNOWN("unknown"),
    LENGTH("length"),
    RANGE("range"),
    FORMAT("format"),
    DECODE_ONLY("decodeOnly"),
  }

  sealed interface Result<out T> {
    data class Ok<T>(val value: T) : Result<T>

    data class Failure(val error: Error) : Result<Nothing>
  }

  private data class Width(val bytes: Int, val min: Long, val max: Long)

  private val integers =
    mapOf(
      "uint8" to Width(1, 0, 0xff),
      "uint16le" to Width(2, 0, 0xffff),
      "int16le" to Width(2, -0x8000, 0x7fff),
      "uint32le" to Width(4, 0, 0xffffffffL),
    )
  private val base64Pattern =
    Regex("^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")
  private val hexPattern = Regex("^(?:[0-9A-Fa-f]{2})*$")

  private fun fail(error: Error) = Result.Failure(error)

  private fun le(bytes: ByteArray) = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)

  fun decode(codec: String, bytes: ByteArray): Result<JsonElement> =
    when {
      codec !in codecs -> fail(Error.UNKNOWN)
      bytes.size > MAX_VALUE_BYTES -> fail(Error.LENGTH)
      else -> decodeKnown(codec, bytes)
    }

  private fun decodeKnown(codec: String, bytes: ByteArray): Result<JsonElement> =
    when (codec) {
      "utf8" -> {
        // Invalid UTF-8 decodes to replacement characters, so it does not round-trip.
        val text = bytes.toString(Charsets.UTF_8)
        if (text.toByteArray(Charsets.UTF_8).contentEquals(bytes)) Result.Ok(JsonPrimitive(text))
        else fail(Error.FORMAT)
      }
      "hex" -> Result.Ok(JsonPrimitive(bytes.joinToString("") { "%02x".format(it) }))
      "base64" -> Result.Ok(JsonPrimitive(Base64.getEncoder().encodeToString(bytes)))
      "float32le" -> decodeFloat(bytes)
      "gatt.battery_level" ->
        when {
          bytes.size != 1 -> fail(Error.LENGTH)
          bytes[0].toInt() and 0xff > 100 -> fail(Error.RANGE)
          else -> Result.Ok(JsonPrimitive(bytes[0].toInt() and 0xff))
        }
      "gatt.heart_rate_measurement" -> decodeHeartRate(bytes)
      else -> decodeInteger(codec, bytes)
    }

  private fun decodeFloat(bytes: ByteArray): Result<JsonElement> {
    if (bytes.size != 4) return fail(Error.LENGTH)
    val value = le(bytes).float
    return if (value.isFinite()) Result.Ok(number(value.toDouble())) else fail(Error.RANGE)
  }

  private fun decodeInteger(codec: String, bytes: ByteArray): Result<JsonElement> {
    if (bytes.size != integers.getValue(codec).bytes) return fail(Error.LENGTH)
    val buffer = le(bytes)
    val value: Long =
      when (codec) {
        "uint8" -> (bytes[0].toInt() and 0xff).toLong()
        "uint16le" -> (buffer.short.toInt() and 0xffff).toLong()
        "int16le" -> buffer.short.toLong()
        else -> buffer.int.toLong() and 0xffffffffL
      }
    return Result.Ok(JsonPrimitive(value))
  }

  private fun uint16(bytes: ByteArray, offset: Int) =
    (bytes[offset].toInt() and 0xff) or ((bytes[offset + 1].toInt() and 0xff) shl 8)

  private fun decodeHeartRate(bytes: ByteArray): Result<JsonElement> {
    if (bytes.size < 2) return fail(Error.LENGTH)
    val flags = bytes[0].toInt() and 0xff
    val wide = flags and 0x01 != 0
    var offset = if (wide) 3 else 2
    if (bytes.size < offset) return fail(Error.LENGTH)
    val energy = flags and 0x08 != 0
    if (energy && bytes.size < offset + 2) return fail(Error.LENGTH)
    val energyOffset = offset
    if (energy) offset += 2
    val rest = bytes.size - offset
    val intervals = flags and 0x10 != 0
    if (if (intervals) rest % 2 != 0 else rest != 0) return fail(Error.LENGTH)
    return Result.Ok(
      buildJsonObject {
        put("heartRate", if (wide) uint16(bytes, 1) else bytes[1].toInt() and 0xff)
        put(
          "sensorContact",
          when {
            flags and 0x04 == 0 -> "unsupported"
            flags and 0x02 != 0 -> "detected"
            else -> "notDetected"
          },
        )
        if (energy) put("energyExpended", uint16(bytes, energyOffset))
        if (intervals) {
          // RR intervals are in 1/1024 s; report whole milliseconds.
          val ms =
            (0 until rest / 2).map {
              JsonPrimitive((uint16(bytes, offset + it * 2) * 1000.0 / 1024).roundToLong())
            }
          put("rrIntervalsMs", JsonArray(ms))
        }
      },
    )
  }

  /** Whole numbers stay integers so they compare equal to JSON literals like `4660`. */
  private fun number(value: Double): JsonPrimitive =
    if (value == Math.rint(value) && kotlin.math.abs(value) < 1e15) JsonPrimitive(value.toLong())
    else JsonPrimitive(value)

  fun encode(codec: String, value: JsonElement): Result<ByteArray> {
    if (codec !in codecs) return fail(Error.UNKNOWN)
    val result = encodeKnown(codec, value)
    return if (result is Result.Ok && result.value.size > MAX_VALUE_BYTES) fail(Error.LENGTH)
    else result
  }

  private fun encodeKnown(codec: String, value: JsonElement): Result<ByteArray> {
    if (codec.startsWith("gatt.")) return fail(Error.DECODE_ONLY)
    val primitive = value as? JsonPrimitive ?: return fail(Error.FORMAT)
    return if (codec == "utf8" || codec == "hex" || codec == "base64") {
      if (!primitive.isString) fail(Error.FORMAT) else encodeText(codec, primitive.content)
    } else {
      val number = primitive.takeIf { !it.isString }?.doubleOrNull ?: return fail(Error.FORMAT)
      encodeNumber(codec, number)
    }
  }

  private fun encodeText(codec: String, text: String): Result<ByteArray> =
    when (codec) {
      "utf8" -> Result.Ok(text.toByteArray(Charsets.UTF_8))
      "hex" ->
        if (!hexPattern.matches(text)) fail(Error.FORMAT)
        else Result.Ok(text.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
      else ->
        if (!base64Pattern.matches(text)) fail(Error.FORMAT)
        else Result.Ok(Base64.getDecoder().decode(text))
    }

  private fun encodeNumber(codec: String, value: Double): Result<ByteArray> {
    if (codec == "float32le") {
      if (!value.isFinite() || !value.toFloat().isFinite()) return fail(Error.RANGE)
      return Result.Ok(
        ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putFloat(value.toFloat()).array(),
      )
    }
    val width = integers.getValue(codec)
    if (value != Math.rint(value) || value < width.min || value > width.max)
      return fail(Error.RANGE)
    val whole = value.toLong()
    return Result.Ok(ByteArray(width.bytes) { ((whole shr (8 * it)) and 0xff).toByte() })
  }
}
