package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int

/** Null count is infinite; finite counts are constrained to 1..20 by the wire contract. */
@Serializable(with = PrototypeIconEffectRepeatSerializer::class)
data class PrototypeIconEffectRepeat(val count: Int? = null)

object PrototypeIconEffectRepeatSerializer : KSerializer<PrototypeIconEffectRepeat> {
  override val descriptor: SerialDescriptor =
    PrimitiveSerialDescriptor("PrototypeIconEffectRepeat", PrimitiveKind.STRING)

  override fun deserialize(decoder: Decoder): PrototypeIconEffectRepeat {
    val value = (decoder as JsonDecoder).decodeJsonElement() as JsonPrimitive
    return if (value.isString && value.content == "infinite") PrototypeIconEffectRepeat()
    else PrototypeIconEffectRepeat(value.int.also { require(it in 1..20) })
  }

  override fun serialize(encoder: Encoder, value: PrototypeIconEffectRepeat) {
    val count = value.count
    if (count == null) encoder.encodeString("infinite") else encoder.encodeInt(count)
  }
}
