package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.constrainWidth
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

/**
 * Placement preference and minimum strip space; layout also checks the measured pages. Infinity
 * represents unbounded wrap sizing.
 */
internal fun pagerIndicatorBelow(
  placement: String?,
  availableSizeDp: Float = Float.POSITIVE_INFINITY,
): Boolean = placement == "below" && availableSizeDp > 22f

/** Allocate the remaining space beside the strip only when that dimension fills and is bounded. */
internal fun pagerIndicatorPagesUseWeight(
  vertical: Boolean,
  fill: PrototypePageFill,
  bounded: Boolean = true,
): Boolean = bounded && if (vertical) fill.width else fill.height

internal data class PrototypePagerIndicator(
  val style: String?,
  val placement: String?,
  val fill: PrototypePageFill,
)

@Composable
internal fun PrototypePagerIndicatorLayout(
  pager: PagerState,
  vertical: Boolean,
  indicator: PrototypePagerIndicator,
  modifier: Modifier,
  pages: @Composable (Modifier) -> Unit,
) {
  if (indicator.style != "dots") {
    pages(modifier)
  } else if (!pagerIndicatorBelow(indicator.placement)) {
    pages(modifier.pagerIndicator(pager, vertical))
  } else {
    PrototypePagerIndicatorBelow(pager, vertical, indicator.fill, modifier, pages)
  }
}

@Composable
private fun PrototypePagerIndicatorBelow(
  pager: PagerState,
  vertical: Boolean,
  fill: PrototypePageFill,
  modifier: Modifier,
  pages: @Composable (Modifier) -> Unit,
) {
  Layout(
    modifier = modifier,
    content = {
      Box(propagateMinConstraints = true) {
        pages(
          if (vertical && fill.height) Modifier.fillMaxHeight()
          else if (!vertical && fill.width) Modifier.fillMaxWidth() else Modifier,
        )
      }
      Box(Modifier.pagerIndicator(pager, vertical))
    },
  ) { measurables, constraints ->
    val strip = 22.dp.roundToPx()
    val measure = pagerIndicatorPageMeasure(constraints, vertical, fill, strip)
    val page = measurables[0].measure(measure.pageConstraints)
    val pageSize = IntSize(page.width, page.height)
    val below = pagerIndicatorFitsBelow(measure, vertical, strip, pageSize)
    val placement = pagerIndicatorPlacement(constraints, vertical, strip, pageSize, below)
    val dots = measurables[1].measure(placement.dotsConstraints)
    layout(placement.size.width, placement.size.height) {
      page.placeRelative(0, 0)
      dots.placeRelative(placement.dotsOffset.x, placement.dotsOffset.y)
    }
  }
}

private data class PrototypePagerIndicatorMeasure(
  val pageConstraints: Constraints,
  val canReserve: Boolean,
  val bounded: Boolean,
  val available: Int,
)

private fun pagerIndicatorPageMeasure(
  constraints: Constraints,
  vertical: Boolean,
  fill: PrototypePageFill,
  strip: Int,
): PrototypePagerIndicatorMeasure {
  val bounded = if (vertical) constraints.hasBoundedWidth else constraints.hasBoundedHeight
  val available = if (vertical) constraints.maxWidth else constraints.maxHeight
  // Tiny bounds use overlay; never reserve a strip leaving less than another strip for pages.
  val canReserve = !bounded || available - strip >= strip
  val weight = canReserve && pagerIndicatorPagesUseWeight(vertical, fill, bounded)
  val pageMax = if (weight) available - strip else available
  val pageMin =
    if (weight) pageMax
    else if (canReserve) 0 else if (vertical) constraints.minWidth else constraints.minHeight
  val pageConstraints =
    if (vertical) constraints.copy(minWidth = pageMin, maxWidth = pageMax)
    else constraints.copy(minHeight = pageMin, maxHeight = pageMax)
  return PrototypePagerIndicatorMeasure(pageConstraints, canReserve, bounded, available)
}

private fun pagerIndicatorFitsBelow(
  measure: PrototypePagerIndicatorMeasure,
  vertical: Boolean,
  strip: Int,
  pageSize: IntSize,
): Boolean {
  val pageExtent = if (vertical) pageSize.width else pageSize.height
  // Wrap pages are measured first. If the complete strip will not fit, draw over the pages.
  return measure.canReserve && (!measure.bounded || measure.available - pageExtent >= strip)
}

private data class PrototypePagerIndicatorPlacement(
  val size: IntSize,
  val dotsConstraints: Constraints,
  val dotsOffset: IntOffset,
)

private fun pagerIndicatorPlacement(
  constraints: Constraints,
  vertical: Boolean,
  strip: Int,
  pageSize: IntSize,
  below: Boolean,
): PrototypePagerIndicatorPlacement {
  val extra = if (!below) IntSize.Zero else if (vertical) IntSize(strip, 0) else IntSize(0, strip)
  val size =
    IntSize(
      constraints.constrainWidth(pageSize.width + extra.width),
      constraints.constrainHeight(pageSize.height + extra.height),
    )
  val dotsSize =
    if (!below) size
    else if (vertical) IntSize(strip, pageSize.height) else IntSize(pageSize.width, strip)
  val dotsOffset =
    if (!below) IntOffset.Zero
    else if (vertical) IntOffset(pageSize.width, 0) else IntOffset(0, pageSize.height)
  return PrototypePagerIndicatorPlacement(
    size,
    Constraints.fixed(dotsSize.width, dotsSize.height),
    dotsOffset,
  )
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
