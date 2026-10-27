package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Build
import androidx.compose.ui.graphics.Color
import dev.jasonpearson.automobile.protocol.PrototypeDegradedEffect
import dev.jasonpearson.automobile.protocol.PrototypeModeValue
import kotlinx.serialization.json.JsonObject

/**
 * `style.effects` (#15129, `prototype_effects_v1`): the closed, paint-only looks of #15128 decoded
 * from the validated JSON. Omitted params take the conservative defaults below (subtle, never
 * covering the node); the contract has already range-checked everything that is present.
 *
 * Decisions the contract left to the renderer:
 * - `phase` and `animate` move only the effects with a natural cycle (`shimmer`, `wave`, `ripple`).
 *   `noise`, `gradientMesh`, `glow`, `vignette`, `blur`, `pixelate` and `chromaticAberration` are
 *   static looks: `phase` and `animate` are accepted, count against the limits, and change nothing.
 * - Colours (`color`, `colors`) resolve exactly like `style.color`: hex keeps its alpha, a Material
 *   role comes from the active scheme, a `{light, dark}` pair picks the shown mode. The `scrim`
 *   role is not special-cased.
 */
internal sealed interface PrototypeEffect {
  val type: String
  val animatePeriodMs: Int?
  val phase: Float

  data class Noise(
    val amount: Float,
    val grainDp: Float,
    val seed: Int,
    val monochrome: Boolean,
    override val animatePeriodMs: Int?,
    override val phase: Float,
  ) : PrototypeEffect {
    override val type = "noise"
  }

  data class GradientMesh(
    val colors: List<PrototypeModeValue>,
    val softness: Float,
    override val animatePeriodMs: Int?,
    override val phase: Float,
  ) : PrototypeEffect {
    override val type = "gradientMesh"
  }

  data class Shimmer(
    val color: PrototypeModeValue?,
    val angle: Float,
    val width: Float,
    override val animatePeriodMs: Int?,
    override val phase: Float,
  ) : PrototypeEffect {
    override val type = "shimmer"
  }

  data class Glow(
    val color: PrototypeModeValue,
    val radiusDp: Float,
    val intensity: Float,
    override val animatePeriodMs: Int?,
    override val phase: Float,
  ) : PrototypeEffect {
    override val type = "glow"
  }

  data class Vignette(
    val color: PrototypeModeValue?,
    val intensity: Float,
    val radius: Float,
    override val animatePeriodMs: Int?,
    override val phase: Float,
  ) : PrototypeEffect {
    override val type = "vignette"
  }

  data class Blur(
    val radiusDp: Float,
    override val animatePeriodMs: Int?,
    override val phase: Float,
  ) : PrototypeEffect {
    override val type = "blur"
  }

  data class Pixelate(
    val cellDp: Float,
    override val animatePeriodMs: Int?,
    override val phase: Float,
  ) : PrototypeEffect {
    override val type = "pixelate"
  }

  data class ChromaticAberration(
    val offsetDp: Float,
    val angle: Float,
    override val animatePeriodMs: Int?,
    override val phase: Float,
  ) : PrototypeEffect {
    override val type = "chromaticAberration"
  }

  data class Wave(
    val amplitudeDp: Float,
    val wavelengthDp: Float,
    val angle: Float,
    override val animatePeriodMs: Int?,
    override val phase: Float,
  ) : PrototypeEffect {
    override val type = "wave"
  }

  data class Ripple(
    val amplitudeDp: Float,
    val wavelengthDp: Float,
    val centerX: Float,
    val centerY: Float,
    override val animatePeriodMs: Int?,
    override val phase: Float,
  ) : PrototypeEffect {
    override val type = "ripple"
  }
}

/** The effects that move when `animate` is present; the rest are static looks (see above). */
internal val PrototypeEffect.cycles: Boolean
  get() =
    this is PrototypeEffect.Shimmer ||
      this is PrototypeEffect.Wave ||
      this is PrototypeEffect.Ripple

/** Whether this effect's `animate` makes the node run a frame clock. */
internal val PrototypeEffect.animated: Boolean
  get() = cycles && animatePeriodMs != null

/** Effects that distort the node's own pixels through a layer [android.graphics.RenderEffect]. */
internal val PrototypeEffect.distorts: Boolean
  get() =
    this is PrototypeEffect.Blur ||
      this is PrototypeEffect.Pixelate ||
      this is PrototypeEffect.ChromaticAberration ||
      this is PrototypeEffect.Wave ||
      this is PrototypeEffect.Ripple

/** The first API level each effect renders on; below it the effect is omitted (reason `api`). */
internal val PrototypeEffect.minSdk: Int
  get() =
    when (this) {
      is PrototypeEffect.Shimmer,
      is PrototypeEffect.Glow,
      is PrototypeEffect.Vignette -> 1
      is PrototypeEffect.Blur -> Build.VERSION_CODES.S
      is PrototypeEffect.Noise,
      is PrototypeEffect.GradientMesh,
      is PrototypeEffect.Pixelate,
      is PrototypeEffect.ChromaticAberration,
      is PrototypeEffect.Wave,
      is PrototypeEffect.Ripple -> Build.VERSION_CODES.TIRAMISU
    }

/**
 * What a node draws on a device at [sdk]: the effects in order, and the ones it had to omit. Both
 * lists keep each effect's index in the authored `style.effects` list, which reports use.
 */
internal class PrototypeEffectPlan(
  val indexed: List<IndexedValue<PrototypeEffect>>,
  val omitted: List<IndexedValue<PrototypeEffect>>,
) {
  val drawn: List<PrototypeEffect> = indexed.map { it.value }
  val distortions: List<PrototypeEffect> = drawn.filter { it.distorts }
  val animated: Boolean = drawn.any { it.animated }
  val isEmpty: Boolean = drawn.isEmpty()

  companion object {
    val EMPTY = PrototypeEffectPlan(emptyList(), emptyList())
  }
}

internal fun prototypeEffectPlan(effects: List<JsonObject>?, sdk: Int): PrototypeEffectPlan {
  if (effects.isNullOrEmpty()) return PrototypeEffectPlan.EMPTY
  // An unknown shape is skipped, but the authored index of the rest is kept.
  val parsed =
    effects.withIndex().mapNotNull { (index, raw) ->
      prototypeParseEffect(raw)?.let { IndexedValue(index, it) }
    }
  val (drawn, omitted) = parsed.partition { sdk >= it.value.minSdk }
  return PrototypeEffectPlan(drawn, omitted)
}

/** The effect colours resolve like `style.color` against the shown palette. */
internal fun prototypeEffectColor(
  palette: PrototypePalette,
  spec: PrototypeModeValue?,
): Color? = spec?.let { prototypeResolveColor(palette, null, it) }

internal const val PROTOTYPE_DEGRADED_API = "api"
internal const val PROTOTYPE_DEGRADED_BUDGET = "budget"

/** `<node identity>.style.effects[<authored index>]`: one path form for every `reason`. */
internal fun prototypeEffectPath(identity: String, authoredIndex: Int): String =
  "$identity.style.effects[$authoredIndex]"

/**
 * Every effect on a visible node of the current render tree that this device cannot draw at [sdk],
 * so a host can tell the author a look is missing. A path is the node's render identity (the
 * `root.child...` key the renderer uses) plus the authored effect index; it follows whichever
 * `styleWhen` style is in force now. Entries are in tree order.
 */
internal fun prototypeDegradedEffects(
  root: PrototypeRenderNode,
  sdk: Int,
): List<PrototypeDegradedEffect> {
  val found = mutableListOf<PrototypeDegradedEffect>()
  fun visit(node: PrototypeRenderNode) {
    if (!node.visible) return
    prototypeEffectPlan(node.style.source.effects, sdk).omitted.forEach {
      found +=
        PrototypeDegradedEffect(
          prototypeEffectPath(node.identity, it.index),
          it.value.type,
          PROTOTYPE_DEGRADED_API,
        )
    }
    node.children.forEach(::visit)
  }
  visit(root)
  return found
}

/**
 * What `inspect_prototypes` and a show reply report for [runtime]: effects this device cannot draw
 * (`api`) followed by those that froze over the frame budget (`budget`).
 */
@InternalAutoMobilePrototypeApi
fun prototypeEffectReport(
  root: PrototypeRenderNode,
  health: PrototypeEffectHealth,
): List<PrototypeDegradedEffect> =
  prototypeDegradedEffects(root, Build.VERSION.SDK_INT) + health.snapshot()
