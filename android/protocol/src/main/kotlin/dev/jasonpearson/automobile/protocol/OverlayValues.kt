package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.*

/**
 * Untagged JSON unions have typed model values and explicit serializers, not decoder heuristics.
 */
@Serializable(with = OverlayDimensionSerializer::class)
sealed class OverlayDimension {
  data object Fill : OverlayDimension()

  data object Wrap : OverlayDimension()

  data class Dp(val dp: Double) : OverlayDimension()
}

/** A dp number, or a Material 3 Shapes step (`none`, `extraSmall` ... `extraLarge`, `full`). */
@Serializable(with = OverlayCornerRadiusSerializer::class)
sealed class OverlayCornerRadius {
  data class Dp(val dp: Double) : OverlayCornerRadius()

  data class Token(val name: String) : OverlayCornerRadius()

  companion object {
    val TOKENS = setOf("none", "extraSmall", "small", "medium", "large", "extraLarge", "full")
  }
}

@Serializable(with = OverlayDetentSerializer::class)
sealed class OverlayDetent {
  data object Half : OverlayDetent()

  data object Full : OverlayDetent()

  data class Dp(val dp: Double) : OverlayDetent()
}

@Serializable(with = OverlayPageTargetSerializer::class)
sealed class OverlayPageTarget {
  data object Next : OverlayPageTarget()

  data object Prev : OverlayPageTarget()

  data class Index(val index: Int) : OverlayPageTarget()
}

@Serializable(with = OverlayScalarSerializer::class)
sealed class OverlayScalar {
  data class Text(val value: String) : OverlayScalar()

  data class Numeric(val value: Double) : OverlayScalar()

  data class BooleanValue(val value: Boolean) : OverlayScalar()
}

abstract class OverlayJsonValueSerializer<T>(name: String) : KSerializer<T> {
  final override val descriptor = buildClassSerialDescriptor(name)

  final override fun deserialize(decoder: Decoder): T {
    val json =
      decoder as? JsonDecoder ?: throw SerializationException("Overlay values require JSON")
    return fromJson(json.decodeJsonElement())
  }

  final override fun serialize(encoder: Encoder, value: T) {
    val json =
      encoder as? JsonEncoder ?: throw SerializationException("Overlay values require JSON")
    json.encodeJsonElement(toJson(value))
  }

  protected abstract fun fromJson(value: JsonElement): T

  protected abstract fun toJson(value: T): JsonElement
}

private fun dpValue(value: JsonElement, minimum: Double): Double {
  val data = value as? JsonObject ?: throw SerializationException("Expected dp object")
  if (data.keys != setOf("dp")) throw SerializationException("Expected only dp")
  val primitive =
    data.getValue("dp") as? JsonPrimitive ?: throw SerializationException("Expected dp number")
  val number = primitive.takeIf { !it.isString }?.doubleOrNull
  if (number == null || !number.isFinite() || number < minimum)
    throw SerializationException("Invalid dp value")
  return number
}

private fun dpJson(value: Double) = buildJsonObject { put("dp", value) }

object OverlayDimensionSerializer :
  OverlayJsonValueSerializer<OverlayDimension>("OverlayDimension") {
  override fun fromJson(value: JsonElement): OverlayDimension =
    when (value) {
      JsonPrimitive("fill") -> OverlayDimension.Fill
      JsonPrimitive("wrap") -> OverlayDimension.Wrap
      else -> OverlayDimension.Dp(dpValue(value, 0.0))
    }

  override fun toJson(value: OverlayDimension): JsonElement =
    when (value) {
      OverlayDimension.Fill -> JsonPrimitive("fill")
      OverlayDimension.Wrap -> JsonPrimitive("wrap")
      is OverlayDimension.Dp -> dpJson(value.dp)
    }
}

object OverlayCornerRadiusSerializer :
  OverlayJsonValueSerializer<OverlayCornerRadius>("OverlayCornerRadius") {
  override fun fromJson(value: JsonElement): OverlayCornerRadius {
    val primitive = value as? JsonPrimitive ?: throw SerializationException("Invalid cornerRadius")
    if (primitive.isString) {
      if (primitive.content !in OverlayCornerRadius.TOKENS)
        throw SerializationException("Invalid cornerRadius token")
      return OverlayCornerRadius.Token(primitive.content)
    }
    val number = primitive.doubleOrNull
    if (number == null || !number.isFinite() || number < 0.0)
      throw SerializationException("Invalid cornerRadius")
    return OverlayCornerRadius.Dp(number)
  }

  override fun toJson(value: OverlayCornerRadius): JsonElement =
    when (value) {
      is OverlayCornerRadius.Dp -> JsonPrimitive(value.dp)
      is OverlayCornerRadius.Token -> JsonPrimitive(value.name)
    }
}

object OverlayDetentSerializer : OverlayJsonValueSerializer<OverlayDetent>("OverlayDetent") {
  override fun fromJson(value: JsonElement): OverlayDetent =
    when (value) {
      JsonPrimitive("half") -> OverlayDetent.Half
      JsonPrimitive("full") -> OverlayDetent.Full
      else -> OverlayDetent.Dp(dpValue(value, 0.000001))
    }

  override fun toJson(value: OverlayDetent): JsonElement =
    when (value) {
      OverlayDetent.Half -> JsonPrimitive("half")
      OverlayDetent.Full -> JsonPrimitive("full")
      is OverlayDetent.Dp -> dpJson(value.dp)
    }
}

object OverlayPageTargetSerializer :
  OverlayJsonValueSerializer<OverlayPageTarget>("OverlayPageTarget") {
  override fun fromJson(value: JsonElement): OverlayPageTarget {
    if (value == JsonPrimitive("next")) return OverlayPageTarget.Next
    if (value == JsonPrimitive("prev")) return OverlayPageTarget.Prev
    val primitive = value as? JsonPrimitive ?: throw SerializationException("Expected page index")
    val number = primitive.takeIf { !it.isString }?.doubleOrNull
    if (
      number == null ||
        !number.isFinite() ||
        number < 0 ||
        number > Int.MAX_VALUE ||
        number % 1.0 != 0.0
    ) {
      throw SerializationException("Invalid page index")
    }
    return OverlayPageTarget.Index(number.toInt())
  }

  override fun toJson(value: OverlayPageTarget): JsonElement =
    when (value) {
      OverlayPageTarget.Next -> JsonPrimitive("next")
      OverlayPageTarget.Prev -> JsonPrimitive("prev")
      is OverlayPageTarget.Index -> JsonPrimitive(value.index)
    }
}

object OverlayScalarSerializer : OverlayJsonValueSerializer<OverlayScalar>("OverlayScalar") {
  override fun fromJson(value: JsonElement): OverlayScalar {
    val primitive = value as? JsonPrimitive ?: throw SerializationException("Expected scalar")
    if (primitive.isString) return OverlayScalar.Text(primitive.content)
    primitive.booleanOrNull?.let {
      return OverlayScalar.BooleanValue(it)
    }
    val number = primitive.doubleOrNull
    if (number == null || !number.isFinite()) throw SerializationException("Expected finite number")
    return OverlayScalar.Numeric(number)
  }

  override fun toJson(value: OverlayScalar): JsonElement =
    when (value) {
      is OverlayScalar.Text -> JsonPrimitive(value.value)
      is OverlayScalar.Numeric -> JsonPrimitive(value.value)
      is OverlayScalar.BooleanValue -> JsonPrimitive(value.value)
    }
}
