package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import dev.jasonpearson.automobile.protocol.PrototypeZoomable

/** Pure zoom math for a `zoomable` image (#14208): scale stays in 1..max, pan stays in bounds. */
internal object PrototypeZoom {
  private const val DOUBLE_TAP_SCALE = 2f
  private const val STEP = 1.5f

  /** A double tap zooms a resting image to 2x (or its max) and resets a zoomed one. */
  fun toggle(scale: Float, max: Float): Float = if (scale > 1f) 1f else minOf(DOUBLE_TAP_SCALE, max)

  fun zoomIn(scale: Float, max: Float): Float = (scale * STEP).coerceAtMost(max)

  fun zoomOut(scale: Float): Float = (scale / STEP).coerceAtLeast(1f)

  /** The pan that keeps the scaled image covering its box: at most half the overflow each way. */
  fun clampPan(offset: Offset, scale: Float, size: IntSize): Offset {
    val maxX = size.width * (scale - 1f) / 2f
    val maxY = size.height * (scale - 1f) / 2f
    return Offset(offset.x.coerceIn(-maxX, maxX), offset.y.coerceIn(-maxY, maxY))
  }
}

/**
 * Runs [onDoubleTap] for a second tap within the double-tap timeout. Nothing is consumed, so the
 * node's own `onTap` (outside this modifier) still runs for each tap.
 */
private suspend fun PointerInputScope.detectDoubleTap(onDoubleTap: () -> Unit) {
  awaitEachGesture {
    awaitFirstDown(requireUnconsumed = false)
    if (waitForUpOrCancellation() == null) return@awaitEachGesture
    withTimeoutOrNull(viewConfiguration.doubleTapTimeoutMillis) {
      awaitFirstDown(requireUnconsumed = false)
    } ?: return@awaitEachGesture
    if (waitForUpOrCancellation() != null) onDoubleTap()
  }
}

/**
 * Pinch, double-tap and pan zoom for an image with `zoomable` (#14208), clipped to its box. Zoom
 * changes apply directly, so they never animate and `observe` sees settled bounds. TalkBack gets
 * "Zoom in" and "Zoom out" actions.
 */
@Composable
internal fun Modifier.prototypeZoomable(zoom: PrototypeZoomable?): Modifier {
  if (zoom == null) return this
  val max = zoom.maxScale.toFloat()
  var scale by remember { mutableFloatStateOf(1f) }
  var pan by remember { mutableStateOf(Offset.Zero) }
  var size by remember { mutableStateOf(IntSize.Zero) }
  fun zoomTo(next: Float) {
    scale = next
    pan = PrototypeZoom.clampPan(pan, next, size)
  }
  val transform = rememberTransformableState { zoomChange, panChange, _ ->
    scale = (scale * zoomChange).coerceIn(1f, max)
    pan = PrototypeZoom.clampPan(pan + panChange, scale, size)
  }
  return onSizeChanged { size = it }
    .clipToBounds()
    .semantics {
      customActions =
        listOf(
          CustomAccessibilityAction("Zoom in") {
            true.also { zoomTo(PrototypeZoom.zoomIn(scale, max)) }
          },
          CustomAccessibilityAction("Zoom out") {
            true.also { zoomTo(PrototypeZoom.zoomOut(scale)) }
          },
        )
    }
    .pointerInput(max) { detectDoubleTap { zoomTo(PrototypeZoom.toggle(scale, max)) } }
    // A resting image lets a parent scroll or pager take one-finger drags.
    .transformable(transform, canPan = { scale > 1f })
    .graphicsLayer {
      scaleX = scale
      scaleY = scale
      translationX = pan.x
      translationY = pan.y
    }
}
