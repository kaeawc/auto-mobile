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
@Serializable(with = PrototypeDimensionSerializer::class)
sealed class PrototypeDimension {
  data object Fill : PrototypeDimension()

  data object Wrap : PrototypeDimension()

  data class Dp(val dp: Double) : PrototypeDimension()
}

/**
 * `style.fontFamily`: a built-in family name, or a font asset the host uploaded (#10443). The asset
 * form carries only the opaque id; font bytes travel through `put_prototype_asset`.
 */
@Serializable(with = PrototypeFontFamilySerializer::class)
sealed class PrototypeFontFamily {
  data class Named(val name: String) : PrototypeFontFamily()

  data class Asset(val id: String) : PrototypeFontFamily()
}

/**
 * A dp number, a Material 3 Shapes step (`none`, `extraSmall` ... `extraLarge`, `full`), or
 * per-corner dp radii where an omitted corner is square.
 */
@Serializable(with = PrototypeCornerRadiusSerializer::class)
sealed class PrototypeCornerRadius {
  data class Dp(val dp: Double) : PrototypeCornerRadius()

  data class Token(val name: String) : PrototypeCornerRadius()

  data class Corners(
    val topStart: Double? = null,
    val topEnd: Double? = null,
    val bottomEnd: Double? = null,
    val bottomStart: Double? = null,
  ) : PrototypeCornerRadius()

  companion object {
    val TOKENS = setOf("none", "extraSmall", "small", "medium", "large", "extraLarge", "full")
    val CORNERS = listOf("topStart", "topEnd", "bottomEnd", "bottomStart")
  }
}

@Serializable(with = PrototypeDetentSerializer::class)
sealed class PrototypeDetent {
  data object Half : PrototypeDetent()

  data object Full : PrototypeDetent()

  data class Dp(val dp: Double) : PrototypeDetent()
}

@Serializable(with = PrototypePageTargetSerializer::class)
sealed class PrototypePageTarget {
  data object Next : PrototypePageTarget()

  data object Prev : PrototypePageTarget()

  data class Index(val index: Int) : PrototypePageTarget()
}

@Serializable(with = PrototypeScalarSerializer::class)
sealed class PrototypeScalar {
  data class Text(val value: String) : PrototypeScalar()

  data class Numeric(val value: Double) : PrototypeScalar()

  data class BooleanValue(val value: Boolean) : PrototypeScalar()
}

abstract class PrototypeJsonValueSerializer<T>(name: String) : KSerializer<T> {
  final override val descriptor = buildClassSerialDescriptor(name)

  final override fun deserialize(decoder: Decoder): T {
    val json =
      decoder as? JsonDecoder ?: throw SerializationException("Prototype values require JSON")
    return fromJson(json.decodeJsonElement())
  }

  final override fun serialize(encoder: Encoder, value: T) {
    val json =
      encoder as? JsonEncoder ?: throw SerializationException("Prototype values require JSON")
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

object PrototypeDimensionSerializer :
  PrototypeJsonValueSerializer<PrototypeDimension>("PrototypeDimension") {
  override fun fromJson(value: JsonElement): PrototypeDimension =
    when (value) {
      JsonPrimitive("fill") -> PrototypeDimension.Fill
      JsonPrimitive("wrap") -> PrototypeDimension.Wrap
      else -> PrototypeDimension.Dp(dpValue(value, 0.0))
    }

  override fun toJson(value: PrototypeDimension): JsonElement =
    when (value) {
      PrototypeDimension.Fill -> JsonPrimitive("fill")
      PrototypeDimension.Wrap -> JsonPrimitive("wrap")
      is PrototypeDimension.Dp -> dpJson(value.dp)
    }
}

object PrototypeFontFamilySerializer :
  PrototypeJsonValueSerializer<PrototypeFontFamily>("PrototypeFontFamily") {
  override fun fromJson(value: JsonElement): PrototypeFontFamily {
    if (value is JsonPrimitive && value.isString) return PrototypeFontFamily.Named(value.content)
    val data = value as? JsonObject ?: throw SerializationException("Expected font family")
    if (data.keys != setOf("asset")) throw SerializationException("Expected only asset")
    val id =
      (data.getValue("asset") as? JsonPrimitive)?.takeIf { it.isString }?.content
        ?: throw SerializationException("Expected asset id")
    return PrototypeFontFamily.Asset(id)
  }

  override fun toJson(value: PrototypeFontFamily): JsonElement =
    when (value) {
      is PrototypeFontFamily.Named -> JsonPrimitive(value.name)
      is PrototypeFontFamily.Asset -> buildJsonObject { put("asset", value.id) }
    }
}

object PrototypeCornerRadiusSerializer :
  PrototypeJsonValueSerializer<PrototypeCornerRadius>("PrototypeCornerRadius") {
  override fun fromJson(value: JsonElement): PrototypeCornerRadius {
    if (value is JsonObject) return corners(value)
    val primitive = value as? JsonPrimitive ?: throw SerializationException("Invalid cornerRadius")
    if (primitive.isString) {
      if (primitive.content !in PrototypeCornerRadius.TOKENS)
        throw SerializationException("Invalid cornerRadius token")
      return PrototypeCornerRadius.Token(primitive.content)
    }
    val number = primitive.doubleOrNull
    if (number == null || !number.isFinite() || number < 0.0)
      throw SerializationException("Invalid cornerRadius")
    return PrototypeCornerRadius.Dp(number)
  }

  override fun toJson(value: PrototypeCornerRadius): JsonElement =
    when (value) {
      is PrototypeCornerRadius.Dp -> JsonPrimitive(value.dp)
      is PrototypeCornerRadius.Token -> JsonPrimitive(value.name)
      is PrototypeCornerRadius.Corners ->
        buildJsonObject {
          value.topStart?.let { put("topStart", it) }
          value.topEnd?.let { put("topEnd", it) }
          value.bottomEnd?.let { put("bottomEnd", it) }
          value.bottomStart?.let { put("bottomStart", it) }
        }
    }

  private fun corners(value: JsonObject): PrototypeCornerRadius.Corners {
    val unknown = value.keys - PrototypeCornerRadius.CORNERS.toSet()
    if (unknown.isNotEmpty()) throw SerializationException("Unknown corner $unknown")
    fun corner(name: String): Double? {
      val element = value[name] ?: return null
      val number = (element as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
      if (number == null || !number.isFinite() || number < 0.0)
        throw SerializationException("Invalid $name radius")
      return number
    }
    return PrototypeCornerRadius.Corners(
      corner("topStart"),
      corner("topEnd"),
      corner("bottomEnd"),
      corner("bottomStart"),
    )
  }
}

object PrototypeDetentSerializer :
  PrototypeJsonValueSerializer<PrototypeDetent>("PrototypeDetent") {
  override fun fromJson(value: JsonElement): PrototypeDetent =
    when (value) {
      JsonPrimitive("half") -> PrototypeDetent.Half
      JsonPrimitive("full") -> PrototypeDetent.Full
      else -> PrototypeDetent.Dp(dpValue(value, 0.000001))
    }

  override fun toJson(value: PrototypeDetent): JsonElement =
    when (value) {
      PrototypeDetent.Half -> JsonPrimitive("half")
      PrototypeDetent.Full -> JsonPrimitive("full")
      is PrototypeDetent.Dp -> dpJson(value.dp)
    }
}

object PrototypePageTargetSerializer :
  PrototypeJsonValueSerializer<PrototypePageTarget>("PrototypePageTarget") {
  override fun fromJson(value: JsonElement): PrototypePageTarget {
    if (value == JsonPrimitive("next")) return PrototypePageTarget.Next
    if (value == JsonPrimitive("prev")) return PrototypePageTarget.Prev
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
    return PrototypePageTarget.Index(number.toInt())
  }

  override fun toJson(value: PrototypePageTarget): JsonElement =
    when (value) {
      PrototypePageTarget.Next -> JsonPrimitive("next")
      PrototypePageTarget.Prev -> JsonPrimitive("prev")
      is PrototypePageTarget.Index -> JsonPrimitive(value.index)
    }
}

object PrototypeScalarSerializer :
  PrototypeJsonValueSerializer<PrototypeScalar>("PrototypeScalar") {
  override fun fromJson(value: JsonElement): PrototypeScalar {
    val primitive = value as? JsonPrimitive ?: throw SerializationException("Expected scalar")
    if (primitive.isString) return PrototypeScalar.Text(primitive.content)
    primitive.booleanOrNull?.let {
      return PrototypeScalar.BooleanValue(it)
    }
    val number = primitive.doubleOrNull
    if (number == null || !number.isFinite()) throw SerializationException("Expected finite number")
    return PrototypeScalar.Numeric(number)
  }

  override fun toJson(value: PrototypeScalar): JsonElement =
    when (value) {
      is PrototypeScalar.Text -> JsonPrimitive(value.value)
      is PrototypeScalar.Numeric -> JsonPrimitive(value.value)
      is PrototypeScalar.BooleanValue -> JsonPrimitive(value.value)
    }
}
