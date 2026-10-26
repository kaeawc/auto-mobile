package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.ScrollState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeFadeEdges

internal enum class PrototypeFadeEdge {
  TOP,
  BOTTOM,
  LEFT,
  RIGHT,
}

internal data class PrototypeVisibleFade(val edge: PrototypeFadeEdge, val dp: Float)

internal fun prototypeVisibleFades(
  horizontal: Boolean,
  direction: LayoutDirection,
  canScrollBackward: Boolean,
  canScrollForward: Boolean,
  spec: PrototypeFadeEdges?,
): List<PrototypeVisibleFade> {
  if (spec == null) return emptyList()
  val start =
    if (direction == LayoutDirection.Ltr) PrototypeFadeEdge.LEFT else PrototypeFadeEdge.RIGHT
  val end =
    if (direction == LayoutDirection.Ltr) PrototypeFadeEdge.RIGHT else PrototypeFadeEdge.LEFT
  return listOfNotNull(
    (if (horizontal) spec.start else spec.top)
      ?.takeIf { canScrollBackward && it > 0 }
      ?.let {
        PrototypeVisibleFade(if (horizontal) start else PrototypeFadeEdge.TOP, it.toFloat())
      },
    (if (horizontal) spec.end else spec.bottom)
      ?.takeIf { canScrollForward && it > 0 }
      ?.let {
        PrototypeVisibleFade(if (horizontal) end else PrototypeFadeEdge.BOTTOM, it.toFloat())
      },
  )
}

@Composable
internal fun Modifier.prototypeFadeEdges(
  scroll: ScrollState,
  horizontal: Boolean,
  spec: PrototypeFadeEdges?,
  reverse: Boolean = false,
): Modifier {
  if (spec == null) return this
  val direction = LocalLayoutDirection.current
  return graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
    .drawWithContent {
      drawContent()
      val fades =
        prototypeVisibleFades(
          horizontal,
          direction,
          if (reverse) scroll.canScrollForward else scroll.canScrollBackward,
          if (reverse) scroll.canScrollBackward else scroll.canScrollForward,
          spec,
        )
      for ((edge, dp) in fades) {
        val (from, to) = prototypeFadeLine(edge, dp.dp.toPx(), size) ?: continue
        drawRect(
          Brush.linearGradient(listOf(Color.Transparent, Color.Black), from, to),
          blendMode = BlendMode.DstIn,
        )
      }
    }
}

internal fun prototypeFadeLine(
  edge: PrototypeFadeEdge,
  pixels: Float,
  size: Size,
): Pair<Offset, Offset>? {
  val horizontal = edge == PrototypeFadeEdge.LEFT || edge == PrototypeFadeEdge.RIGHT
  val length = pixels.coerceAtMost(if (horizontal) size.width else size.height)
  if (length <= 0f) return null
  val from =
    when (edge) {
      PrototypeFadeEdge.TOP,
      PrototypeFadeEdge.LEFT -> Offset.Zero
      PrototypeFadeEdge.BOTTOM -> Offset(0f, size.height)
      PrototypeFadeEdge.RIGHT -> Offset(size.width, 0f)
    }
  val to =
    when (edge) {
      PrototypeFadeEdge.TOP -> Offset(0f, length)
      PrototypeFadeEdge.BOTTOM -> Offset(0f, size.height - length)
      PrototypeFadeEdge.LEFT -> Offset(length, 0f)
      PrototypeFadeEdge.RIGHT -> Offset(size.width - length, 0f)
    }
  return from to to
}
