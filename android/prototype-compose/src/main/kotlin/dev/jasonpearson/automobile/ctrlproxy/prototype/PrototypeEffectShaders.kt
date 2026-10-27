package dev.jasonpearson.automobile.ctrlproxy.prototype

import kotlin.math.cos
import kotlin.math.sin

/**
 * The AGSL programs behind `style.effects` (#15129), bundled with the library: a spec carries data
 * only, never shader source. API 33 compiles them as `RuntimeShader`; below that the effects that
 * need them are omitted (see [minSdk]). The four distortions sample the node's own pixels through
 * the `content` child shader; `noise` and `gradientMesh` are generators painted as a brush.
 */
internal object PrototypeEffectShaders {
  const val CONTENT = "content"

  /** Snaps sampling to a grid of [cell]-px squares. */
  const val PIXELATE =
    """
uniform shader content;
uniform float cell;
half4 main(float2 p) {
  float2 centre = (floor(p / cell) + 0.5) * cell;
  return content.eval(centre);
}
"""

  /** Splits red and blue apart along [shift] (px) and leaves green in place. */
  const val CHROMATIC_ABERRATION =
    """
uniform shader content;
uniform float2 shift;
half4 main(float2 p) {
  half4 r = content.eval(p + shift);
  half4 g = content.eval(p);
  half4 b = content.eval(p - shift);
  return half4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}
"""

  /** Displaces pixels sideways to the travel direction [dir] by a travelling sine. */
  const val WAVE =
    """
uniform shader content;
uniform float2 dir;
uniform float amplitude;
uniform float wavelength;
uniform float phase;
half4 main(float2 p) {
  float2 side = float2(-dir.y, dir.x);
  float t = dot(p, dir) / wavelength * 6.2831853 - phase;
  return content.eval(p + side * amplitude * sin(t));
}
"""

  /** Displaces pixels radially from [centre] by a decaying outgoing ring wave. */
  const val RIPPLE =
    """
uniform shader content;
uniform float2 centre;
uniform float amplitude;
uniform float wavelength;
uniform float phase;
half4 main(float2 p) {
  float2 d = p - centre;
  float r = length(d);
  float2 n = r > 0.001 ? d / r : float2(0.0, 0.0);
  float falloff = exp(-r / (wavelength * 6.0));
  float w = sin(r / wavelength * 6.2831853 - phase) * amplitude * falloff;
  return content.eval(p + n * w);
}
"""

  /** Seeded value noise; premultiplied output so it blends over the node. */
  const val NOISE =
    """
uniform float grain;
uniform float amount;
uniform float2 seed;
uniform float mono;
float hash(float2 p) {
  return fract(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453);
}
half4 main(float2 p) {
  float2 cell = floor(p / grain) + seed;
  float n = hash(cell);
  float3 c = mono > 0.5 ? float3(n, n, n) : float3(n, hash(cell + 17.0), hash(cell + 31.0));
  return half4(c * amount, amount);
}
"""

  /** Four corner colours blended bilinearly; [softness] eases the blend toward the corners. */
  const val GRADIENT_MESH =
    """
uniform float2 size;
uniform float softness;
layout(color) uniform half4 topStart;
layout(color) uniform half4 topEnd;
layout(color) uniform half4 bottomStart;
layout(color) uniform half4 bottomEnd;
half4 main(float2 p) {
  float2 uv = clamp(p / size, 0.0, 1.0);
  uv = mix(uv, smoothstep(0.0, 1.0, uv), softness);
  half4 top = mix(topStart, topEnd, half(uv.x));
  half4 bottom = mix(bottomStart, bottomEnd, half(uv.x));
  half4 c = mix(top, bottom, half(uv.y));
  return half4(c.rgb * c.a, c.a);
}
"""
}

private const val TWO_PI = (2.0 * Math.PI).toFloat()
private const val SEED_COLUMNS = 256
private const val SEED_X_STRIDE = 1.61f
private const val SEED_Y_STRIDE = 2.37f

/** Unit travel direction for an angle in degrees: 0 runs left to right, 90 top to bottom. */
internal fun prototypeEffectDirection(angleDegrees: Float): Pair<Float, Float> {
  val radians = Math.toRadians(angleDegrees.toDouble())
  return cos(radians).toFloat() to sin(radians).toFloat()
}

/** A cycle position (0..1) as radians for a shader's sine. */
internal fun prototypeEffectRadians(phase: Float): Float = phase * TWO_PI

/**
 * The grid offset a noise [seed] (0..65535) selects: two small components, so the value hash keeps
 * its precision on a mediump GPU and every seed is a different pattern.
 */
internal fun prototypeNoiseSeedOffset(seed: Int): Pair<Float, Float> =
  (seed % SEED_COLUMNS) * SEED_X_STRIDE to (seed / SEED_COLUMNS) * SEED_Y_STRIDE
