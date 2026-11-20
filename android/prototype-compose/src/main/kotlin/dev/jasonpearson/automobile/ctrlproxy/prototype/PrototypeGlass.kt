package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.chrisbanes.haze.HazeInput
import dev.chrisbanes.haze.HazeSourceSelection
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.blur.HazeBlurStyle
import dev.chrisbanes.haze.blur.HazeColorEffect
import dev.chrisbanes.haze.blur.hazeBlur
import dev.chrisbanes.haze.hazeSource
import dev.jasonpearson.automobile.protocol.PrototypeGlass
import dev.jasonpearson.automobile.protocol.PrototypeModeValue
import dev.jasonpearson.automobile.protocol.PrototypeStyle

private val defaultGlass = PrototypeGlass()

internal fun PrototypeStyle.glassMaterial(): PrototypeGlass? =
  glass ?: defaultGlass.takeIf { surface == "glass" }

internal data class PrototypeGlassPlan(
  val blur: Boolean,
  val radiusDp: Int,
  val tint: PrototypeModeValue?,
  val fallbackTint: PrototypeModeValue,
)

internal fun prototypeGlassPlan(glass: PrototypeGlass, sdkInt: Int): PrototypeGlassPlan =
  PrototypeGlassPlan(
    blur = sdkInt >= PrototypeBackdrops.MIN_BLUR_SDK,
    radiusDp =
      PrototypeBackdrops.materialRadiusDp(if (glass.variant == "clear") "ultraThin" else "regular"),
    tint = glass.tint,
    fallbackTint = glass.tint ?: PrototypeModeValue.Single(PrototypeBackdrops.DEFAULT_TONAL_ROLE),
  )

/**
 * Haze samples layers registered by this spec's composition. It cannot see apps or other prototype
 * windows behind it. A glass subtree samples earlier sibling subtrees at each level so it never
 * reads its own content or a source that is currently drawing it.
 */
internal class PrototypeGlassLayers(
  val state: HazeState,
  val behind: Map<String, Set<String>>,
  val sourceOrder: Map<String, Float>,
)

internal val LocalPrototypeGlassLayers = compositionLocalOf<PrototypeGlassLayers?> { null }

internal fun prototypeGlassLayers(
  root: PrototypeRenderNode,
  state: HazeState,
): PrototypeGlassLayers? {
  val earlier = mutableListOf<String>()
  val behind = mutableMapOf<String, Set<String>>()
  val paintOrder = mutableListOf<String>()
  fun visit(node: PrototypeRenderNode) {
    if (node.style.source.glassMaterial() != null) behind[node.identity] = earlier.toSet()
    val originalSize = earlier.size
    for (child in node.children) {
      visit(child)
      earlier.add(child.identity)
      paintOrder.add(child.identity)
    }
    earlier.subList(originalSize, earlier.size).clear()
  }
  visit(root)
  if (behind.isEmpty()) return null
  val sources = behind.values.flatten().toSet()
  val sourceOrder =
    paintOrder.filter(sources::contains).mapIndexed { index, key -> key to (index + 1f) }.toMap()
  return PrototypeGlassLayers(state, behind, sourceOrder)
}

/** A transparent source at the root supplies bounds for a tint or scrim even without siblings. */
@Composable
internal fun Modifier.prototypeGlassBaseSource(): Modifier =
  hazeSource(checkNotNull(LocalPrototypeGlassLayers.current).state)

@Composable
internal fun Modifier.prototypeGlassSource(identity: String): Modifier {
  val layers = LocalPrototypeGlassLayers.current ?: return this
  val order = layers.sourceOrder[identity] ?: return this
  return hazeSource(layers.state, zIndex = order, key = identity)
}

@Composable
internal fun Modifier.prototypeGlassEffect(identity: String, glass: PrototypeGlass?): Modifier {
  val layers = LocalPrototypeGlassLayers.current ?: return this
  if (glass == null) return this
  val behind = layers.behind[identity].orEmpty()
  val selection =
    remember(behind) {
      HazeSourceSelection.All.where {
        val source = it.key
        source == null || (source is String && source in behind)
      }
    }
  val plan = prototypeGlassPlan(glass, Build.VERSION.SDK_INT)
  val tint = prototypeThemedScrim(null, plan.tint)
  val fallback = prototypeThemedScrim(null, plan.fallbackTint)
  val style =
    remember(plan, tint, fallback) {
      HazeBlurStyle {
        blurEnabled(plan.blur)
        blurRadius(plan.radiusDp.dp)
        noiseFactor(0f)
        colorEffects(
          listOfNotNull(
            tint?.let {
              HazeColorEffect.tint(it.copy(alpha = it.alpha * PrototypeBackdrops.BLUR_TINT_ALPHA))
            },
          ),
        )
        fallbackColorEffect(
          fallback?.let {
            HazeColorEffect.tint(it.copy(alpha = it.alpha * PrototypeBackdrops.TONAL_ALPHA))
          },
        )
      }
    }
  return hazeBlur(HazeInput.Sources(layers.state, selection), style)
}
