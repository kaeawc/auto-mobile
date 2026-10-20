package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.pager.PagerState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.carousel.CarouselItemScope
import androidx.compose.material3.carousel.HorizontalCenteredHeroCarousel
import androidx.compose.material3.carousel.HorizontalMultiBrowseCarousel
import androidx.compose.material3.carousel.HorizontalUncontainedCarousel
import androidx.compose.material3.carousel.rememberCarouselState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeCarouselNode

/** A pager indicator dot centre, in pixels, inside the pager's own bounds. */
internal data class PrototypeDot(val x: Float, val y: Float)

/**
 * Dot centres for a pager of [count] pages: a centred row near the bottom for a horizontal pager, a
 * centred column near the end edge for a vertical one. Pure; sizes are pixels.
 */
internal fun pagerIndicatorDots(
  count: Int,
  vertical: Boolean,
  width: Float,
  height: Float,
  radius: Float,
  gap: Float,
  inset: Float,
): List<PrototypeDot> {
  if (count <= 0) return emptyList()
  val step = radius * 2 + gap
  val span = step * (count - 1)
  return List(count) { index ->
    val along = index * step - span / 2
    if (vertical) PrototypeDot(width - inset - radius, height / 2 + along)
    else PrototypeDot(width / 2 + along, height - inset - radius)
  }
}

/** The dots a pager draws over itself: the current page filled, the rest dimmed. */
@Composable
internal fun Modifier.pagerIndicator(pager: PagerState, vertical: Boolean): Modifier {
  val color = MaterialTheme.colorScheme.onSurface
  return drawWithContent {
    drawContent()
    val radius = 3.dp.toPx()
    val dots =
      pagerIndicatorDots(
        pager.pageCount,
        vertical,
        size.width,
        size.height,
        radius,
        gap = 8.dp.toPx(),
        inset = 8.dp.toPx(),
      )
    dots.forEachIndexed { index, dot ->
      drawCircle(
        if (index == pager.currentPage) color else color.copy(alpha = 0.38f),
        radius,
        Offset(dot.x, dot.y),
      )
    }
  }
}

/** Material carousel (multi-browse, centred hero or uncontained) over the node's expanded items. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RenderPrototypeCarousel(
  node: PrototypeRenderNode,
  modifier: Modifier,
  renderItem: @Composable (PrototypeRenderNode) -> Unit,
) {
  val source = node.source as? PrototypeCarouselNode ?: return
  // A repeat over no items leaves nothing to scroll; Material carousels need at least one item.
  if (node.children.isEmpty()) {
    Box(modifier)
    return
  }
  val state = rememberCarouselState { node.children.size }
  val width = source.itemWidth.toFloat().dp
  val spacing = (source.itemSpacing ?: 0.0).toFloat().dp
  val item: @Composable CarouselItemScope.(Int) -> Unit = { index ->
    Box(Modifier.maskClip(MaterialTheme.shapes.extraLarge)) {
      val child = node.children[index]
      key(child.identity) { renderItem(child) }
    }
  }
  when (source.variant) {
    "hero" ->
      HorizontalCenteredHeroCarousel(
        state = state,
        modifier = modifier,
        maxItemWidth = width,
        itemSpacing = spacing,
        content = item,
      )
    "uncontained" ->
      HorizontalUncontainedCarousel(
        state = state,
        itemWidth = width,
        modifier = modifier,
        itemSpacing = spacing,
        content = item,
      )
    else ->
      HorizontalMultiBrowseCarousel(
        state = state,
        preferredItemWidth = width,
        modifier = modifier,
        itemSpacing = spacing,
        content = item,
      )
  }
}
