package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.platform.LocalDensity
import dev.jasonpearson.automobile.protocol.keyframeValue
import dev.jasonpearson.automobile.protocol.prototypeKeyframePoints
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive

/** One progress clock per node; a new trigger cancels the old play and starts at zero. */
@Composable
internal fun rememberPrototypeKeyframeProgress(
  frames: JsonObject,
  trigger: JsonElement?,
): Animatable<Float, androidx.compose.animation.core.AnimationVector1D> {
  val progress = remember { Animatable(1f) }
  val previous = remember { arrayOf(trigger) }
  val profile = LocalPrototypeMotionProfile.current
  val enabled =
    LocalPrototypeMotion.current &&
      (frames["tracks"] as JsonObject).keys.any { prototypeKeyframeTrackEnabled(it, profile) }
  LaunchedEffect(trigger, frames, enabled) {
    val changed = previous[0] != trigger
    previous[0] = trigger
    progress.snapTo(1f)
    if (changed && enabled) {
      progress.snapTo(0f)
      progress.animateTo(
        1f,
        tween(frames.getValue("durationMs").jsonPrimitive.int, easing = LinearEasing),
      )
    }
  }
  ReportPrototypeMotion { enabled && progress.isRunning }
  return progress
}

internal fun prototypeKeyframeTrackEnabled(name: String, profile: PrototypeMotionProfile): Boolean =
  profile == PrototypeMotionProfile.FULL ||
    (profile == PrototypeMotionProfile.REDUCED && name == "alpha")

@Composable
internal fun Modifier.prototypeKeyframes(
  node: PrototypeRenderNode,
  styleTransform: @Composable (Modifier) -> Modifier = { it },
): Modifier {
  val frames = node.source?.keyframes ?: return styleTransform(this)
  val progress = rememberPrototypeKeyframeProgress(frames, node.keyframeTrigger)
  val profile = LocalPrototypeMotionProfile.current
  val tracks =
    remember(frames) {
      (frames["tracks"] as JsonObject).mapValues { (_, track) ->
        prototypeKeyframePoints(track) to
          ((track as? JsonObject)?.get("curve") as? JsonPrimitive)?.content.orEmpty().ifEmpty {
            "standard"
          }
      }
    }
  val density = LocalDensity.current.density
  fun value(name: String, rest: Float): Float {
    if (!prototypeKeyframeTrackEnabled(name, profile)) return rest
    val (points, curve) = tracks[name] ?: return rest
    return keyframeValue(points, curve, progress.value.toDouble()).toFloat()
  }
  // Translation wraps the style transform so style scale/rotation cannot multiply the offset.
  val translated =
    if (tracks.containsKey("offsetX") || tracks.containsKey("offsetY")) {
      val translation = rememberGraphicsLayer()
      drawWithContent {
        translation.record { this@drawWithContent.drawContent() }
        translation.translationX = value("offsetX", 0f) * density
        translation.translationY = value("offsetY", 0f) * density
        drawLayer(translation)
      }
    } else this
  val styled = styleTransform(translated)
  val layer = rememberGraphicsLayer()
  return styled.drawWithContent {
    layer.record { this@drawWithContent.drawContent() }
    layer.scaleX = value("scale", 1f) * value("scaleX", 1f)
    layer.scaleY = value("scale", 1f) * value("scaleY", 1f)
    layer.rotationZ = value("rotation", 0f)
    layer.alpha = value("alpha", 1f)
    drawLayer(layer)
  }
}
