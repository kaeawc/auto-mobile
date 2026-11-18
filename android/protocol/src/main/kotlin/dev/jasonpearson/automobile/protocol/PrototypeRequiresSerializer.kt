package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.*

/** Accepts the capability array as well as the existing platform requirements block. */
object PrototypeRequiresSerializer : KSerializer<PrototypeRequires> {
  override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

  override fun deserialize(decoder: Decoder): PrototypeRequires {
    val input = decoder as JsonDecoder
    val value = input.decodeJsonElement()
    return if (value is JsonArray)
      PrototypeRequires(capabilities = value.map { it.jsonPrimitive.content })
    else input.json.decodeFromJsonElement<PrototypeRequires>(value)
  }

  override fun serialize(encoder: Encoder, value: PrototypeRequires) {
    val output = encoder as JsonEncoder
    output.encodeJsonElement(
      if (value.capabilities.isNotEmpty()) JsonArray(value.capabilities.map(::JsonPrimitive))
      else output.json.encodeToJsonElement(value),
    )
  }
}
