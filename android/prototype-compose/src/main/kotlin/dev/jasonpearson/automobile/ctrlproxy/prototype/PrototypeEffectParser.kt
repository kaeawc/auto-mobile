package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeModeValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

private const val DEFAULT_NOISE_AMOUNT = 0.1f
private const val DEFAULT_GRAIN_DP = 1f
private const val DEFAULT_SOFTNESS = 0.5f
private const val DEFAULT_SHIMMER_ANGLE = 20f
private const val DEFAULT_SHIMMER_WIDTH = 0.3f
private const val DEFAULT_GLOW_RADIUS_DP = 12f
private const val DEFAULT_GLOW_INTENSITY = 0.6f
private const val DEFAULT_VIGNETTE_INTENSITY = 0.4f
private const val DEFAULT_VIGNETTE_RADIUS = 0.7f
private const val DEFAULT_ABERRATION_OFFSET_DP = 2f
private const val DEFAULT_AMPLITUDE_DP = 4f
private const val DEFAULT_WAVELENGTH_DP = 48f
private const val DEFAULT_CENTER = 0.5f

private fun JsonObject.float(key: String, default: Float): Float =
  (get(key) as? JsonPrimitive)?.doubleOrNull?.toFloat() ?: default

private fun modeValue(element: JsonElement): PrototypeModeValue? =
  when {
    element is JsonPrimitive && element.isString -> PrototypeModeValue.Single(element.content)
    element is JsonObject -> {
      val light = (element["light"] as? JsonPrimitive)?.contentOrNull
      val dark = (element["dark"] as? JsonPrimitive)?.contentOrNull
      if (light != null && dark != null) PrototypeModeValue.Modes(light, dark) else null
    }
    else -> null
  }

private class EffectCommon(val period: Int?, val phase: Float)

private fun parseNoise(raw: JsonObject, c: EffectCommon): PrototypeEffect =
  PrototypeEffect.Noise(
    raw.float("amount", DEFAULT_NOISE_AMOUNT),
    raw.float("grain", DEFAULT_GRAIN_DP),
    (raw["seed"] as? JsonPrimitive)?.intOrNull ?: 0,
    (raw["monochrome"] as? JsonPrimitive)?.booleanOrNull ?: true,
    c.period,
    c.phase,
  )

private fun parseGradientMesh(raw: JsonObject, c: EffectCommon): PrototypeEffect? {
  val colors = (raw["colors"] as? JsonArray).orEmpty().mapNotNull { modeValue(it) }
  if (colors.size != MESH_COLORS) return null
  return PrototypeEffect.GradientMesh(
    colors,
    raw.float("softness", DEFAULT_SOFTNESS),
    c.period,
    c.phase,
  )
}

private fun parseShimmer(raw: JsonObject, c: EffectCommon): PrototypeEffect =
  PrototypeEffect.Shimmer(
    raw["color"]?.let(::modeValue),
    raw.float("angle", DEFAULT_SHIMMER_ANGLE),
    raw.float("width", DEFAULT_SHIMMER_WIDTH),
    c.period,
    c.phase,
  )

private fun parseGlow(raw: JsonObject, c: EffectCommon): PrototypeEffect? =
  raw["color"]?.let(::modeValue)?.let {
    PrototypeEffect.Glow(
      it,
      raw.float("radius", DEFAULT_GLOW_RADIUS_DP),
      raw.float("intensity", DEFAULT_GLOW_INTENSITY),
      c.period,
      c.phase,
    )
  }

private fun parseVignette(raw: JsonObject, c: EffectCommon): PrototypeEffect =
  PrototypeEffect.Vignette(
    raw["color"]?.let(::modeValue),
    raw.float("intensity", DEFAULT_VIGNETTE_INTENSITY),
    raw.float("radius", DEFAULT_VIGNETTE_RADIUS),
    c.period,
    c.phase,
  )

private fun parseChromaticAberration(raw: JsonObject, c: EffectCommon): PrototypeEffect =
  PrototypeEffect.ChromaticAberration(
    raw.float("offset", DEFAULT_ABERRATION_OFFSET_DP),
    raw.float("angle", 0f),
    c.period,
    c.phase,
  )

private fun parseWave(raw: JsonObject, c: EffectCommon): PrototypeEffect =
  PrototypeEffect.Wave(
    raw.float("amplitude", DEFAULT_AMPLITUDE_DP),
    raw.float("wavelength", DEFAULT_WAVELENGTH_DP),
    raw.float("angle", 0f),
    c.period,
    c.phase,
  )

private fun parseRipple(raw: JsonObject, c: EffectCommon): PrototypeEffect {
  val center = raw["center"] as? JsonObject
  return PrototypeEffect.Ripple(
    raw.float("amplitude", DEFAULT_AMPLITUDE_DP),
    raw.float("wavelength", DEFAULT_WAVELENGTH_DP),
    center?.float("x", DEFAULT_CENTER) ?: DEFAULT_CENTER,
    center?.float("y", DEFAULT_CENTER) ?: DEFAULT_CENTER,
    c.period,
    c.phase,
  )
}

private val EFFECT_PARSERS: Map<String, (JsonObject, EffectCommon) -> PrototypeEffect?> =
  mapOf(
    "noise" to ::parseNoise,
    "gradientMesh" to ::parseGradientMesh,
    "shimmer" to ::parseShimmer,
    "glow" to ::parseGlow,
    "vignette" to ::parseVignette,
    "blur" to { raw, c -> PrototypeEffect.Blur(raw.float("radius", 0f), c.period, c.phase) },
    "pixelate" to { raw, c -> PrototypeEffect.Pixelate(raw.float("cell", 1f), c.period, c.phase) },
    "chromaticAberration" to ::parseChromaticAberration,
    "wave" to ::parseWave,
    "ripple" to ::parseRipple,
  )

/**
 * One validated effect object, or null for a shape this renderer does not know (the validator
 * already refused those, so null only guards a hand-built model).
 */
internal fun prototypeParseEffect(raw: JsonObject): PrototypeEffect? {
  val period =
    (raw["animate"] as? JsonObject)?.get("periodMs")?.let { (it as? JsonPrimitive)?.intOrNull }
  val type = (raw["type"] as? JsonPrimitive)?.contentOrNull ?: return null
  return EFFECT_PARSERS[type]?.invoke(raw, EffectCommon(period, raw.float("phase", 0f)))
}

private const val MESH_COLORS = 4
