package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonPrimitive

/**
 * Wire form of `perfTiming`: the service embeds the perf snapshot as a JSON object (not as a quoted
 * string), so a `String` holding that JSON is written back out as the embedded value. The Kotlin
 * type stays `String?`, which keeps the published wire-contract descriptor unchanged.
 *
 * A value that is not valid JSON is written as an ordinary string, and a non-string element decodes
 * to its compact JSON text, so both wire shapes round-trip.
 */
object PerfTimingJsonSerializer : KSerializer<String> {
  override val descriptor = PrimitiveSerialDescriptor("PerfTimingJson", PrimitiveKind.STRING)

  override fun serialize(encoder: Encoder, value: String) {
    val element =
      if (encoder is JsonEncoder) {
        try {
          Json.parseToJsonElement(value)
        } catch (_: SerializationException) {
          // Not JSON: keep the legacy quoted-string shape rather than dropping the value.
          JsonPrimitive(value)
        }
      } else {
        JsonPrimitive(value)
      }
    if (encoder is JsonEncoder) encoder.encodeJsonElement(element) else encoder.encodeString(value)
  }

  override fun deserialize(decoder: Decoder): String {
    if (decoder !is JsonDecoder) return decoder.decodeString()
    val element: JsonElement = decoder.decodeJsonElement()
    return if (element is JsonPrimitive && element.isString) element.content else element.toString()
  }
}
