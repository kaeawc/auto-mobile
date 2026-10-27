package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonUnquotedLiteral

/**
 * A `String` that already holds JSON the sender produced (a serialized hierarchy, element or
 * object) and is embedded on the wire as that JSON value, not as a quoted string (#11877).
 *
 * Unlike [PerfTimingJsonSerializer], the text is written verbatim without being parsed, because a
 * hierarchy can be large and is re-sent on every change. The sender must pass valid JSON; it comes
 * from kotlinx.serialization, never from a caller. Decoding returns the element's compact JSON
 * text.
 */
object RawJsonSerializer : KSerializer<String> {
  override val descriptor = PrimitiveSerialDescriptor("RawJson", PrimitiveKind.STRING)

  @OptIn(ExperimentalSerializationApi::class)
  override fun serialize(encoder: Encoder, value: String) {
    if (encoder is JsonEncoder) {
      encoder.encodeJsonElement(JsonUnquotedLiteral(value))
    } else {
      encoder.encodeString(value)
    }
  }

  override fun deserialize(decoder: Decoder): String {
    if (decoder !is JsonDecoder) return decoder.decodeString()
    val element: JsonElement = decoder.decodeJsonElement()
    return if (element is JsonPrimitive && element.isString) element.content else element.toString()
  }
}
