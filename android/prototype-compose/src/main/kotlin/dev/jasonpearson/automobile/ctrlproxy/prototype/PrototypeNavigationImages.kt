package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeItem

@Composable
internal fun rememberPrototypeImageBitmap(image: BitmapPrototypeImage, asset: String): ImageBitmap {
  val probe = LocalPrototypeRenderWorkProbe.current
  return remember(image) {
    probe?.invoke(PrototypeRenderWork.IMAGE_BITMAP_WRAP, asset)
    image.imageBitmap
  }
}

/** A nav item's image, built-in icon or placeholder, per [prototypeNavigationVisual]. */
@Composable
internal fun PrototypeNavigationIcon(item: PrototypeItem) {
  val dark = LocalPrototypeDark.current
  val image = item.image?.let { prototypeModeValue(it, dark) }
  val state = image?.let { rememberPrototypeImage(it, NAVIGATION_ICON_TARGET) }
  when (val visual = prototypeNavigationVisual(item, state)) {
    is PrototypeNavigationVisual.Image ->
      (visual.image as? BitmapPrototypeImage)?.let {
        Image(
          rememberPrototypeImageBitmap(it, checkNotNull(image)),
          contentDescription = null,
          modifier = Modifier.size(24.dp),
        )
      } ?: NavigationPlaceholder()
    is PrototypeNavigationVisual.Icon ->
      Icon(checkNotNull(prototypeIcon(visual.name)), contentDescription = null)
    PrototypeNavigationVisual.Loading ->
      Box(Modifier.size(24.dp).background(prototypePlaceholderColor(MaterialTheme.colorScheme)))
    PrototypeNavigationVisual.Placeholder -> NavigationPlaceholder()
  }
}

@Composable
private fun NavigationPlaceholder() {
  Box(
    Modifier.size(24.dp).background(prototypePlaceholderColor(MaterialTheme.colorScheme)),
  )
}

/** Nav icons are drawn at 24 dp; decode for up to xxxhdpi so they stay sharp on any display. */
private val NAVIGATION_ICON_TARGET = PrototypeImageTarget(96, 96)
