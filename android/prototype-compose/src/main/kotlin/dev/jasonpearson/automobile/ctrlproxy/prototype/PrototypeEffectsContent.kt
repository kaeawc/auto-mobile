package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalView

/**
 * The window's [PrototypeEffectHealth]; null outside a controller-driven show (tests, previews).
 */
internal val LocalPrototypeEffectHealth = compositionLocalOf<PrototypeEffectHealth?> { null }

/** The API level effects are planned against; tests substitute it to exercise the fallbacks. */
internal val LocalPrototypeEffectSdk = compositionLocalOf { Build.VERSION.SDK_INT }

/*
 * `style.effects` on one node (#15129): distortions as a layer RenderEffect around the node's
 * background and content, `gradientMesh` between the background and the content, and `shimmer`,
 * `glow`, `vignette` and `noise` painted over the content, clipped to the node's shape. Effects
 * never change layout, hit testing or semantics and draw nothing outside the node's bounds.
 */

/** Plans [node]'s effects for this device; [PrototypeEffectPlan.EMPTY] when it authors none. */
@Composable
internal fun rememberPrototypeEffectPlan(node: PrototypeRenderNode): PrototypeEffectPlan {
  val effects = node.style.source.effects
  val sdk = LocalPrototypeEffectSdk.current
  return remember(effects, sdk) { prototypeEffectPlan(effects, sdk) }
}

/**
 * The elapsed nanoseconds of the node's animation clock, read in draw. It is 0 (so every effect
 * shows its authored `phase`) unless the plan animates and motion is on (`motion` is not `none`,
 * animator scale above 0). It stops when the node is hidden or an effect blows the frame budget.
 */
@Composable
internal fun rememberPrototypeEffectElapsed(
  plan: PrototypeEffectPlan,
  identity: String,
): () -> Long {
  val elapsed = remember { mutableLongStateOf(0L) }
  val motion = LocalPrototypeMotion.current
  val running = plan.animated && motion
  if (running) {
    ReportPrototypeMotion(loop = true) { true }
    val health = LocalPrototypeEffectHealth.current
    val view = LocalView.current
    LaunchedEffect(plan, identity) {
      val budget = PrototypeEffectBudget {
        plan.drawn.forEachIndexed { index, effect ->
          if (effect.animated) health?.markBudget("$identity.style.effects[$index]", effect.type)
        }
      }
      PrototypeEffectClock(ComposeFrameSource, budget).run(
        motionEnabled = { true },
        visible = { view.isShown },
      ) {
        elapsed.longValue = it
      }
    }
  }
  return if (running) ({ elapsed.longValue }) else ({ 0L })
}

/** Distortions (blur, pixelate, chromatic aberration, wave, ripple) as one chained layer effect. */
@Composable
internal fun Modifier.prototypeEffectLayer(
  plan: PrototypeEffectPlan,
  elapsed: () -> Long,
): Modifier {
  if (plan.distortions.isEmpty()) return this
  val shaders = remember { PrototypeEffectShaderCache() }
  return graphicsLayer {
    // Clip so a displaced or blurred edge never leaves the node's bounds.
    clip = true
    renderEffect =
      prototypeLayerEffect(plan.distortions, shaders, EffectFrame(density, size, elapsed()))
  }
}

/** The `gradientMesh` fill, drawn between the node's background and its content. */
@Composable
internal fun Modifier.prototypeEffectUnderlay(plan: PrototypeEffectPlan, shape: Shape): Modifier {
  val meshes = plan.drawn.filterIsInstance<PrototypeEffect.GradientMesh>()
  if (meshes.isEmpty() || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return this
  val palette = prototypePalette()
  val shader = remember { MeshHolder() }
  return drawWithContent {
    withShapeClip(shape) { meshes.forEach { drawMesh(it, palette, shader) } }
    drawContent()
  }
}

/** Shimmer, glow, vignette and noise, over the content, in authored order. */
@Composable
internal fun Modifier.prototypeEffectOverlay(
  plan: PrototypeEffectPlan,
  shape: Shape,
  elapsed: () -> Long,
): Modifier {
  val painted =
    plan.drawn.filter {
      it is PrototypeEffect.Shimmer ||
        it is PrototypeEffect.Glow ||
        it is PrototypeEffect.Vignette ||
        it is PrototypeEffect.Noise
    }
  if (painted.isEmpty()) return this
  val palette = prototypePalette()
  val noise = remember { NoiseHolder() }
  return drawWithContent {
    drawContent()
    val nanos = elapsed()
    withShapeClip(shape) {
      painted.forEach { effect ->
        val phase =
          prototypeEffectPhase(effect.phase, effect.animatePeriodMs.takeIf { effect.cycles }, nanos)
        when (effect) {
          is PrototypeEffect.Shimmer -> drawShimmer(effect, palette, phase)
          is PrototypeEffect.Glow -> drawGlow(effect, palette)
          is PrototypeEffect.Vignette -> drawVignette(effect, palette)
          is PrototypeEffect.Noise -> drawNoise(effect, noise)
          else -> Unit
        }
      }
    }
  }
}
