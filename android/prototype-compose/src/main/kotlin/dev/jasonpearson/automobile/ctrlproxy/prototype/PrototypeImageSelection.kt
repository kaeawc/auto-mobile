package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.layout.ContentScale
import dev.jasonpearson.automobile.protocol.PrototypeBottomNavNode
import dev.jasonpearson.automobile.protocol.PrototypeFontFamily
import dev.jasonpearson.automobile.protocol.PrototypeImageNode
import dev.jasonpearson.automobile.protocol.PrototypeItem
import dev.jasonpearson.automobile.protocol.PrototypeNode
import dev.jasonpearson.automobile.protocol.PrototypeShader
import dev.jasonpearson.automobile.protocol.PrototypeTabBarNode
import dev.jasonpearson.automobile.protocol.PrototypeTextNode

/**
 * What a nav item draws, decided without Compose or Android. An item's `image` takes precedence;
 * while it decodes the item shows [Loading]; when it cannot be drawn (unknown or unreadable asset)
 * the item falls back to its built-in `icon`, then to the visible [Placeholder].
 */
internal sealed interface PrototypeNavigationVisual {
  data class Image(val image: PrototypeDecodedImage) : PrototypeNavigationVisual

  data class Icon(val name: String) : PrototypeNavigationVisual

  data object Loading : PrototypeNavigationVisual

  data object Placeholder : PrototypeNavigationVisual
}

/** [imageState] is null exactly when the item names no image. */
internal fun prototypeNavigationVisual(
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
internal fun prototypeContentScale(name: String): ContentScale =
  when (name) {
    "crop" -> ContentScale.Crop
    "fill" -> ContentScale.FillBounds
    else -> ContentScale.Fit
  }

/** Font asset ids a node's own `style` and `styleWhen` entries name, in order. */
private fun prototypeFontAssetReferences(node: PrototypeNode): List<String> =
  (listOfNotNull(node.style) + node.styleWhen.orEmpty().map { it.style }).mapNotNull {
    (it.fontFamily as? PrototypeFontFamily.Asset)?.id
  } +
    (node as? PrototypeTextNode)?.spans.orEmpty().mapNotNull {
      (it.style?.fontFamily as? PrototypeFontFamily.Asset)?.id
    }

/**
 * Every asset id the tree references, in first-use order without repeats: `image` nodes and the
 * `image` of `tabBar` and `bottomNav` items. Covers nodes that are currently hidden or on another
 * pager page, because those can be revealed without another `show`. Font assets named by
 * `style.fontFamily: {asset}` and `style.shader` (also inside `styleWhen`) are included.
 */
@InternalAutoMobilePrototypeApi
fun prototypeAssetReferences(root: PrototypeNode): List<String> {
  val ids = LinkedHashSet<String>()
  fun visit(node: PrototypeNode) {
    prototypeFontAssetReferences(node).forEach { ids += it }
    prototypeNodeShaders(node).forEach { ids += it.asset }
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

/** Includes inactive style alternatives and hidden descendants, before a spec can be shown. */
internal fun prototypeNodeShaders(node: PrototypeNode): List<PrototypeShader> =
  (listOfNotNull(node.style) + node.styleWhen.orEmpty().map { it.style }).mapNotNull { it.shader }

@InternalAutoMobilePrototypeApi
fun validatePrototypeShaderUniforms(root: PrototypeNode, lookup: (String) -> PrototypeAssetInfo?) {
  fun visit(node: PrototypeNode) {
    prototypeNodeShaders(node).forEach { shader ->
      // Unknown ids retain the existing missingAssets warning/re-upload path.
      val info = lookup(shader.asset) ?: return@forEach
      require(info.mimeType == "application/vnd.automobile.agsl") {
        "Shader asset '${shader.asset}' must have AGSL MIME type."
      }
      val declared =
        requireNotNull(info.shaderUniforms) {
          "Shader asset '${shader.asset}' has not been compiled by this device."
        }
      prototypeShaderUniformValues(declared, shader.uniforms.orEmpty())
    }
    prototypeDescendants(node).forEach(::visit)
  }
  visit(root)
}
