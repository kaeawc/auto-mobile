package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.*

internal fun declaredPrototypeCapabilities(requires: JsonElement?): List<String> =
  ((requires as? JsonArray) ?: ((requires as? JsonObject)?.get("capabilities") as? JsonArray))
    .orEmpty()
    .mapNotNull { (it as? JsonPrimitive)?.takeIf { value -> value.isString }?.content }

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
      if (
        value.capabilities.isNotEmpty() &&
          value.platform == null &&
          value.permissions == null &&
          value.background == null
      )
        JsonArray(value.capabilities.map(::JsonPrimitive))
      else output.json.encodeToJsonElement(value),
    )
  }
}
