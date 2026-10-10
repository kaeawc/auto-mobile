package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.OverlayStyle

/**
 * Reserve explicit gaps first, then distribute remaining free space using the chosen arrangement.
 */
fun overlayHorizontalArrangement(style: OverlayStyle): Arrangement.Horizontal {
  val base =
    when (style.arrangement) {
      "center" -> Arrangement.Center
      "end" -> Arrangement.End
      "spaceBetween" -> Arrangement.SpaceBetween
      "spaceAround" -> Arrangement.SpaceAround
      "spaceEvenly" -> Arrangement.SpaceEvenly
      else -> Arrangement.Start
    }
  return object : Arrangement.Horizontal {
    override val spacing = (style.spacing ?: 0.0).toFloat().dp

    override fun Density.arrange(
      totalSize: Int,
      sizes: IntArray,
      layoutDirection: LayoutDirection,
      outPositions: IntArray,
    ) {
      val gap = spacing.roundToPx()
      with(base) {
        arrange(
          totalSize - gap * (sizes.size - 1).coerceAtLeast(0),
          sizes,
          layoutDirection,
          outPositions,
        )
      }
      outPositions.indices.forEach { index ->
        outPositions[index] +=
          gap * if (layoutDirection == LayoutDirection.Ltr) index else sizes.lastIndex - index
      }
    }
  }
}

fun overlayVerticalArrangement(style: OverlayStyle): Arrangement.Vertical {
  val base =
    when (style.arrangement) {
      "center" -> Arrangement.Center
      "end" -> Arrangement.Bottom
      "spaceBetween" -> Arrangement.SpaceBetween
      "spaceAround" -> Arrangement.SpaceAround
      "spaceEvenly" -> Arrangement.SpaceEvenly
      else -> Arrangement.Top
    }
  return object : Arrangement.Vertical {
    override val spacing = (style.spacing ?: 0.0).toFloat().dp

    override fun Density.arrange(totalSize: Int, sizes: IntArray, outPositions: IntArray) {
      val gap = spacing.roundToPx()
      with(base) {
        arrange(totalSize - gap * (sizes.size - 1).coerceAtLeast(0), sizes, outPositions)
      }
      outPositions.indices.forEach { index -> outPositions[index] += gap * index }
    }
  }
}
