package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.InfiniteAnimationPolicy
import dev.jasonpearson.automobile.protocol.PrototypeIconEffect
import dev.jasonpearson.automobile.protocol.PrototypeIconNode
import kotlin.coroutines.coroutineContext
import kotlin.math.sin
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

internal data class PrototypeIconFrame(
  val scale: Float = 1f,
  val alpha: Float = 1f,
  val rotation: Float = 0f,
)

/** Temporary local engine pending #15249; one 600 ms cycle always ends at rest. */
internal fun prototypeIconFrame(
  type: String,
  phase: Float,
  held: Boolean = false,
): PrototypeIconFrame {
  val wave = sin(phase * Math.PI).toFloat()
  return when (type) {
    "bounce" -> PrototypeIconFrame(scale = 1f + .2f * wave)
    "pulse",
    "variableColor" -> PrototypeIconFrame(alpha = 1f - .6f * wave)
    "scale" -> PrototypeIconFrame(scale = if (held) 1.15f else 1f + .15f * wave)
    "wiggle" -> PrototypeIconFrame(rotation = 10f * sin(phase * 4 * Math.PI).toFloat())
    "rotate" -> PrototypeIconFrame(rotation = if (phase >= 1f) 0f else 360f * phase)
    "breathe" -> PrototypeIconFrame(scale = 1f + .06f * wave, alpha = 1f - .3f * wave)
    "replace" -> PrototypeIconFrame(scale = .85f + .15f * phase, alpha = phase)
    "drawOn" -> PrototypeIconFrame(alpha = phase)
    else -> PrototypeIconFrame()
  }
}

internal fun prototypeIconTruthy(value: JsonElement?): Boolean {
  if (value == null || value == JsonNull) return false
  val primitive = value as? JsonPrimitive ?: return true
  if (primitive.isString) return primitive.content.isNotEmpty()
  return primitive != JsonPrimitive(false) && primitive.doubleOrNull != 0.0
}

private data class IconMotionPlan(
  val full: Boolean,
  val enabled: Boolean,
  val captured: Boolean,
  val replacement: Boolean,
  val scaleTrigger: Boolean,
  val loop: Boolean,
) {
  fun shouldRun(nameChanged: Boolean, triggerChanged: Boolean, hasTrigger: Boolean): Boolean {
    if (!enabled || captured || scaleTrigger) return false
    if (replacement) return nameChanged
    return !hasTrigger || triggerChanged
  }

  fun frame(type: String, phase: Float, scale: Float): PrototypeIconFrame {
    if (!enabled || captured) return PrototypeIconFrame()
    if (!full) return PrototypeIconFrame()
    if (scaleTrigger) return PrototypeIconFrame(scale = scale)
    return prototypeIconFrame(type, phase)
  }
}

private fun iconMotionPlan(
  effect: PrototypeIconEffect,
  motion: Boolean,
  profile: PrototypeMotionProfile,
  capture: Boolean,
): IconMotionPlan {
  val full = motion && profile == PrototypeMotionProfile.FULL
  val reducedReplace =
    motion && profile == PrototypeMotionProfile.REDUCED && effect.type == "replace"
  val loop = full && effect.repeat != null
  return IconMotionPlan(
    full,
    full || reducedReplace,
    capture && loop,
    effect.type in setOf("replace", "drawOn"),
    effect.type == "scale" && effect.trigger != null,
    loop,
  )
}

@Composable
internal fun rememberPrototypeIconFrame(
  effect: PrototypeIconEffect?,
  value: JsonElement?,
  name: String?,
  capture: Boolean = false,
): PrototypeIconFrame {
  if (effect == null) return PrototypeIconFrame()
  val plan =
    iconMotionPlan(
      effect,
      LocalPrototypeMotion.current,
      LocalPrototypeMotionProfile.current,
      capture,
    )
  TrackPrototypeIconCapture(plan.loop && plan.enabled)
  val targetScale = if (plan.full && plan.scaleTrigger && prototypeIconTruthy(value)) 1.15f else 1f
  val scale by
    animateFloatAsState(
      targetScale,
      if (plan.full) tween(300) else snap(),
      label = "prototypeIconScale",
    )
  ReportPrototypeMotion { scale != targetScale }
  val phase = remember { Animatable(1f) }
  var running by remember { mutableStateOf(false) }
  var previousName by remember { mutableStateOf(name) }
  var previousValue by remember { mutableStateOf(value) }
  var completed by remember(effect, if (plan.replacement) name else value) { mutableIntStateOf(0) }
  LaunchedEffect(effect, if (plan.replacement) name else value, plan) {
    val nameChanged = previousName != name
    val triggerChanged = previousValue != value
    previousName = name
    previousValue = value
    running = false
    phase.snapTo(1f)
    if (plan.shouldRun(nameChanged, triggerChanged, effect.trigger != null)) {
      running = true
      try {
        runPrototypeIconCycles(
          if (plan.full) effect else effect.copy(repeat = null),
          phase,
          completed,
        ) {
          completed++
        }
      } finally {
        running = false
      }
    }
  }
  ReportPrototypeMotion(loop = plan.loop) { running }
  return plan.frame(effect.type, phase.value, scale)
}

private suspend fun runPrototypeIconCycles(
  effect: PrototypeIconEffect,
  phase: Animatable<Float, *>,
  completed: Int,
  onCycle: () -> Unit,
) {
  val cycles: suspend () -> Unit = {
    var left = (effect.repeat?.count ?: if (effect.repeat == null) 1 else Int.MAX_VALUE) - completed
    while (left-- > 0) {
      phase.snapTo(0f)
      phase.animateTo(1f, tween(600, easing = LinearEasing))
      onCycle()
    }
  }
  val policy = coroutineContext[InfiniteAnimationPolicy]
  if (effect.repeat != null && policy != null) policy.onInfiniteOperation(cycles) else cycles()
}

@Composable
internal fun Modifier.prototypeIconEffect(node: PrototypeRenderNode): Modifier {
  val effect = (node.source as? PrototypeIconNode)?.effect ?: return this
  val frame =
    rememberPrototypeIconFrame(
      effect,
      node.iconEffectValue,
      node.iconName,
      LocalPrototypeIconCapture.current,
    )
  return graphicsLayer {
    scaleX = frame.scale
    scaleY = frame.scale
    alpha = frame.alpha
    rotationZ = frame.rotation
  }
}

internal val LocalPrototypeIconCapture = androidx.compose.runtime.compositionLocalOf { false }
