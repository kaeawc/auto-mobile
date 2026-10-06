package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.ui.layout.ContentScale
import dev.jasonpearson.automobile.protocol.OverlayBottomNavNode
import dev.jasonpearson.automobile.protocol.OverlayImageNode
import dev.jasonpearson.automobile.protocol.OverlayItem
import dev.jasonpearson.automobile.protocol.OverlayNode
import dev.jasonpearson.automobile.protocol.OverlayTabBarNode

/**
 * What a nav item draws, decided without Compose or Android. An item's `image` takes precedence;
 * while it decodes the item shows [Loading]; when it cannot be drawn (unknown or unreadable asset)
 * the item falls back to its built-in `icon`, then to the visible [Placeholder].
 */
sealed interface OverlayNavigationVisual {
  data class Image(val image: OverlayDecodedImage) : OverlayNavigationVisual

  data class Icon(val name: String) : OverlayNavigationVisual

  data object Loading : OverlayNavigationVisual

  data object Placeholder : OverlayNavigationVisual
}

/** [imageState] is null exactly when the item names no image. */
fun overlayNavigationVisual(
  item: OverlayItem,
  imageState: OverlayImageState?,
): OverlayNavigationVisual =
  when (imageState) {
    is OverlayImageState.Ready -> OverlayNavigationVisual.Image(imageState.image)
    OverlayImageState.Loading -> OverlayNavigationVisual.Loading
    OverlayImageState.Missing,
    null ->
      if (overlayIcon(item.icon) != null) OverlayNavigationVisual.Icon(checkNotNull(item.icon))
      else OverlayNavigationVisual.Placeholder
  }

/** `contentScale` names are closed by the protocol validator: fit, crop, fill. */
fun overlayContentScale(name: String): ContentScale =
  when (name) {
    "crop" -> ContentScale.Crop
    "fill" -> ContentScale.FillBounds
    else -> ContentScale.Fit
  }

/**
 * Every asset id the tree references, in first-use order without repeats: `image` nodes and the
 * `image` of `tabBar` and `bottomNav` items. Covers nodes that are currently hidden or on another
 * pager page, because those can be revealed without another `show`.
 */
fun overlayAssetReferences(root: OverlayNode): List<String> {
  val ids = LinkedHashSet<String>()
  fun visit(node: OverlayNode) {
    when (node) {
      is OverlayImageNode -> ids += node.asset
      is OverlayTabBarNode -> node.items.mapNotNullTo(ids) { it.image }
      is OverlayBottomNavNode -> node.items.mapNotNullTo(ids) { it.image }
      else -> Unit
    }
    overlayDescendants(node).forEach(::visit)
  }
  visit(root)
  return ids.toList()
}
