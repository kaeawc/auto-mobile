package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeLoadingIndicatorNode
import dev.jasonpearson.automobile.protocol.PrototypeProgressNode
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/*
 * Material 3 Expressive indicators (#15258): wavy progress and the loading indicator, drawn on a
 * Canvas because the pinned material3 has neither. Their loops stop when motion is off.
 */

private const val WAVY_REST = 0.3f
private val WAVY_HEIGHT = 10.dp
private val WAVY_AMPLITUDE = 3.dp
private val WAVY_WAVELENGTH = 40.dp
private val WAVY_STROKE = 4.dp
private val WAVY_GAP = 4.dp

/**
 * A wavy linear progress (`progress` `variant: "wavy"`): the active track is a sine stroke, the
 * remaining track a flat line. Bound to a number it is determinate; unbound it is indeterminate,
 * sliding a wavy segment while motion is on and resting at a fixed fraction while it is off.
 */
@Composable
internal fun RenderPrototypeWavyProgress(node: PrototypeRenderNode, modifier: Modifier) {
  val source = node.source as? PrototypeProgressNode ?: return
  val indeterminate = source.stateKey == null
  val fraction = prototypeProgressFraction(node.sliderValue, source.max)
  val moving = indeterminate && LocalPrototypeMotion.current
  val phase = if (moving) prototypeLoopFraction(1200) else 0f
  val active = MaterialTheme.colorScheme.primary
  val track = MaterialTheme.colorScheme.secondaryContainer
  Canvas(
    modifier.fillMaxWidth().height(WAVY_HEIGHT).semantics {
      progressBarRangeInfo =
        if (indeterminate) ProgressBarRangeInfo.Indeterminate
        else ProgressBarRangeInfo(fraction, 0f..1f)
    },
  ) {
    val stroke = WAVY_STROKE.toPx()
    val (start, end) =
      when {
        !indeterminate -> 0f to fraction
        moving -> (phase * 1.3f - 0.3f).coerceIn(0f, 1f) to (phase * 1.3f).coerceIn(0f, 1f)
        else -> 0f to WAVY_REST
      }
    val mid = size.height / 2
    val gap = WAVY_GAP.toPx()
    val startX = start * size.width
    val endX = end * size.width
    val trackStart = if (endX > 0f) endX + gap else 0f
    if (trackStart < size.width) {
      drawLine(track, Offset(trackStart, mid), Offset(size.width, mid), stroke, StrokeCap.Round)
    }
    if (endX - startX > stroke) {
      drawPath(
        prototypeWavePath(
          startX,
          endX,
          mid,
          PrototypeWave(WAVY_AMPLITUDE.toPx(), WAVY_WAVELENGTH.toPx(), phase),
        ),
        active,
        style = Stroke(stroke, cap = StrokeCap.Round),
      )
    }
  }
}

/** A sine path from [startX] to [endX] around [mid]. */
/** A wave's shape: [amplitude] and [wavelength] in px, [phase] 0..1 of a wavelength. */
internal data class PrototypeWave(val amplitude: Float, val wavelength: Float, val phase: Float)

internal fun prototypeWavePath(startX: Float, endX: Float, mid: Float, wave: PrototypeWave): Path {
  val (amplitude, wavelength, phase) = wave
  val path = Path()
  val step = 2f
  var x = startX
  while (x <= endX) {
    val y = mid + amplitude * sin(2 * PI * (x / wavelength - phase)).toFloat()
    if (x == startX) path.moveTo(x, y) else path.lineTo(x, y)
    x += step
  }
  return path
}

@Composable
private fun prototypeLoopFraction(durationMs: Int): Float {
  val transition = rememberInfiniteTransition(label = "expressiveLoop")
  val value by
    transition.animateFloat(
      0f,
      1f,
      infiniteRepeatable(tween(durationMs, easing = LinearEasing), RepeatMode.Restart),
      label = "expressiveLoopFraction",
    )
  return value
}

private val LOADING_SIZE = 48.dp
private val LOADING_ACTIVE = 38.dp

/**
 * The shape-morphing loading indicator (`loadingIndicator`): a rotating rounded polygon whose lobes
 * swell and settle. `contained: true` draws it on a primary-container circle. It is always
 * indeterminate; with motion off it rests as a still seven-lobed shape.
 */
@Composable
internal fun RenderPrototypeLoadingIndicator(node: PrototypeRenderNode, modifier: Modifier) {
  val source = node.source as? PrototypeLoadingIndicatorNode ?: return
  val contained = source.contained == true
  val moving = LocalPrototypeMotion.current
  val loop = if (moving) prototypeLoopFraction(2600) else 0f
  val colors = MaterialTheme.colorScheme
  val color = if (contained) colors.onPrimaryContainer else colors.primary
  val background =
    if (contained) Modifier.background(colors.primaryContainer, CircleShape) else Modifier
  Box(
    modifier.size(LOADING_SIZE).then(background).semantics {
      progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate
    },
    Alignment.Center,
  ) {
    Canvas(Modifier.size(LOADING_ACTIVE)) {
      // Lobe depth breathes twice per loop; the shape turns a full circle per loop.
      val depth = 0.08f + 0.06f * cos(4 * PI * loop).toFloat()
      rotate(360f * loop) {
        drawPath(prototypeLobedPath(size.minDimension / 2, 7, depth, center), color)
      }
    }
  }
}

/** A closed shape of [lobes] rounded lobes: radius modulated by a cosine of relative [depth]. */
internal fun prototypeLobedPath(radius: Float, lobes: Int, depth: Float, center: Offset): Path {
  val path = Path()
  val steps = 96
  val base = radius * (1 - depth)
  for (i in 0..steps) {
    val theta = 2 * PI * i / steps
    val r = base + radius * depth * cos(lobes * theta).toFloat()
    val x = center.x + r * cos(theta).toFloat()
    val y = center.y + r * sin(theta).toFloat()
    if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
  }
  path.close()
  return path
}
