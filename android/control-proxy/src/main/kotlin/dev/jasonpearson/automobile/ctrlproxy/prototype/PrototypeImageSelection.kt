package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.layout.ContentScale
import dev.jasonpearson.automobile.protocol.PrototypeBottomNavNode
import dev.jasonpearson.automobile.protocol.PrototypeFontFamily
import dev.jasonpearson.automobile.protocol.PrototypeImageNode
import dev.jasonpearson.automobile.protocol.PrototypeItem
import dev.jasonpearson.automobile.protocol.PrototypeNode
import dev.jasonpearson.automobile.protocol.PrototypeTabBarNode

/**
 * What a nav item draws, decided without Compose or Android. An item's `image` takes precedence;
 * while it decodes the item shows [Loading]; when it cannot be drawn (unknown or unreadable asset)
 * the item falls back to its built-in `icon`, then to the visible [Placeholder].
 */
sealed interface PrototypeNavigationVisual {
  data class Image(val image: PrototypeDecodedImage) : PrototypeNavigationVisual

  data class Icon(val name: String) : PrototypeNavigationVisual

  data object Loading : PrototypeNavigationVisual

  data object Placeholder : PrototypeNavigationVisual
}

/** [imageState] is null exactly when the item names no image. */
fun prototypeNavigationVisual(
  item: PrototypeItem,
  imageState: PrototypeImageState?,
): PrototypeNavigationVisual =
  when (imageState) {
    is PrototypeImageState.Ready -> PrototypeNavigationVisual.Image(imageState.image)
    PrototypeImageState.Loading -> PrototypeNavigationVisual.Loading
    PrototypeImageState.Missing,
    null ->
      if (prototypeIcon(item.icon) != null) PrototypeNavigationVisual.Icon(checkNotNull(item.icon))
      else PrototypeNavigationVisual.Placeholder
  }

/** `contentScale` names are closed by the protocol validator: fit, crop, fill. */
fun prototypeContentScale(name: String): ContentScale =
  when (name) {
    "crop" -> ContentScale.Crop
    "fill" -> ContentScale.FillBounds
    else -> ContentScale.Fit
  }

/** Font asset ids a node's own `style` and `styleWhen` entries name, in order. */
private fun prototypeFontAssetReferences(node: PrototypeNode): List<String> =
  (listOfNotNull(node.style) + node.styleWhen.orEmpty().map { it.style }).mapNotNull {
    (it.fontFamily as? PrototypeFontFamily.Asset)?.id
  }

/**
 * Every asset id the tree references, in first-use order without repeats: `image` nodes and the
 * `image` of `tabBar` and `bottomNav` items. Covers nodes that are currently hidden or on another
 * pager page, because those can be revealed without another `show`. Font assets named by
 * `style.fontFamily: {asset}` (also inside `styleWhen`) are included.
 */
fun prototypeAssetReferences(root: PrototypeNode): List<String> {
  val ids = LinkedHashSet<String>()
  fun visit(node: PrototypeNode) {
    prototypeFontAssetReferences(node).forEach { ids += it }
    when (node) {
      // A {light, dark} asset pair (#11218) references both ids, whichever mode is drawn.
      is PrototypeImageNode -> ids += node.asset.values
      is PrototypeTabBarNode -> node.items.flatMapTo(ids) { it.image?.values.orEmpty() }
      is PrototypeBottomNavNode -> node.items.flatMapTo(ids) { it.image?.values.orEmpty() }
      else -> Unit
    }
    prototypeDescendants(node).forEach(::visit)
  }
  visit(root)
  return ids.toList()
}
