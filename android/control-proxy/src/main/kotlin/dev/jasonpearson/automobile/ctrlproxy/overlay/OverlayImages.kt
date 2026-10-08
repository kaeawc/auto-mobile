package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.OverlayDimension
import dev.jasonpearson.automobile.protocol.OverlayImageNode
import dev.jasonpearson.automobile.protocol.OverlayItem

/** Supplied by [OverlayRuntimeContent]; null (previews, tests) draws every image as missing. */
internal val LocalOverlayImageCache = compositionLocalOf<OverlayImageCache?> { null }

/** A [Bitmap] the cache can account for. */
class BitmapOverlayImage(val bitmap: Bitmap) : OverlayDecodedImage {
  override val width: Int
    get() = bitmap.width

  override val height: Int
    get() = bitmap.height

  override val byteCount: Long
    get() = bitmap.allocationByteCount.toLong()
}

/**
 * [BitmapFactory] decoding with `inSampleSize` chosen by [overlayImageSampleSize], so only a
 * display-sized bitmap is ever allocated (never the full-resolution one). Needs real Android bitmap
 * decoding, so it is verified on a device rather than in JVM unit tests; the sampling, caching and
 * fallback logic around it is unit tested with a fake decoder.
 */
class BitmapOverlayImageDecoder(private val maxPixels: Long = DEFAULT_MAX_DECODED_PIXELS) :
  OverlayImageDecoder {
  override fun decode(bytes: ByteArray, target: OverlayImageTarget): OverlayDecodedImage? =
    try {
      decodeSampled(bytes, target)
    } catch (error: OutOfMemoryError) {
      Log.w(TAG, "Overlay image decode ran out of memory (${bytes.size} encoded bytes)", error)
      null
    }

  private fun decodeSampled(bytes: ByteArray, target: OverlayImageTarget): OverlayDecodedImage? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
      Log.w(TAG, "Overlay image bytes are not decodable (${bytes.size} bytes)")
      return null
    }
    val options =
      BitmapFactory.Options().apply {
        inSampleSize = overlayImageSampleSize(bounds.outWidth, bounds.outHeight, target, maxPixels)
      }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.let(::BitmapOverlayImage)
  }

  companion object {
    /** 4 Mi pixels, 16 MiB as ARGB_8888: above a 1080x2400 screen (about 2.6 Mi pixels). */
    const val DEFAULT_MAX_DECODED_PIXELS = 4L * 1024 * 1024

    private const val TAG = "OverlayImageDecoder"
  }
}

/**
 * The state to draw for [assetId] at [target]. Starts from the cache when it already has the answer
 * so a cached image shows on the first frame, decodes off the main thread otherwise, and reloads
 * whenever the store replaces, removes or clears an asset.
 */
@Composable
internal fun rememberOverlayImage(assetId: String, target: OverlayImageTarget): OverlayImageState {
  val cache = LocalOverlayImageCache.current ?: return OverlayImageState.Missing
  val version by cache.version.collectAsState()
  val state by
    produceState<OverlayImageState>(
      cache.peek(assetId, target) ?: OverlayImageState.Loading,
      cache,
      assetId,
      target,
      version,
    ) {
      value = cache.load(assetId, target)
    }
  return state
}

/** The display size to decode for: the incoming constraint when bounded, else the screen. */
@Composable
private fun overlayImageTarget(constraints: Constraints): OverlayImageTarget {
  val density = LocalDensity.current
  val configuration = LocalConfiguration.current
  fun screenPx(dp: Int) = with(density) { dp.dp.roundToPx() }
  return OverlayImageTarget(
    if (constraints.hasBoundedWidth) constraints.maxWidth
    else screenPx(configuration.screenWidthDp),
    if (constraints.hasBoundedHeight) constraints.maxHeight
    else screenPx(configuration.screenHeightDp),
  )
}

/**
 * An `image` node: the asset at `contentScale`, a neutral box while decoding, a placeholder if
 * missing.
 */
@Composable
internal fun OverlayImageContent(node: OverlayRenderNode, modifier: Modifier) {
  val source = node.source as? OverlayImageNode ?: return
  val background =
    overlayThemedColor(node.style.background, node.style.source.background) ?: Color.LightGray
  BoxWithConstraints(modifier.defaultMinSize(24.dp, 24.dp)) {
    val state = rememberOverlayImage(source.asset, overlayImageTarget(constraints))
    val image = (state as? OverlayImageState.Ready)?.image as? BitmapOverlayImage
    if (image != null) {
      Image(
        image.bitmap.asImageBitmap(),
        contentDescription = null,
        modifier = fillAuthoredAxes(source),
        contentScale = overlayContentScale(source.contentScale),
      )
    } else {
      Box(fillAuthoredAxes(source).background(background), Alignment.Center) {
        if (state != OverlayImageState.Loading)
          Icon(Icons.Default.BrokenImage, contentDescription = null, tint = Color.DarkGray)
      }
    }
  }
}

/**
 * Crop and fill need the image to take the node's whole box; an axis the author left to wrap
 * content keeps the image's natural size on that axis.
 */
private fun fillAuthoredAxes(source: OverlayImageNode): Modifier {
  var modifier: Modifier = Modifier
  if (source.style?.width.isSized()) modifier = modifier.fillMaxWidth()
  if (source.style?.height.isSized()) modifier = modifier.fillMaxHeight()
  return modifier
}

private fun OverlayDimension?.isSized() =
  this is OverlayDimension.Fill || this is OverlayDimension.Dp

/** A nav item's image, built-in icon or placeholder, per [overlayNavigationVisual]. */
@Composable
internal fun OverlayNavigationIcon(item: OverlayItem) {
  val image = item.image
  val state = image?.let { rememberOverlayImage(it, NAVIGATION_ICON_TARGET) }
  when (val visual = overlayNavigationVisual(item, state)) {
    is OverlayNavigationVisual.Image ->
      (visual.image as? BitmapOverlayImage)?.let {
        Image(it.bitmap.asImageBitmap(), contentDescription = null, modifier = Modifier.size(24.dp))
      } ?: NavigationPlaceholder()
    is OverlayNavigationVisual.Icon ->
      Icon(checkNotNull(overlayIcon(visual.name)), contentDescription = null)
    OverlayNavigationVisual.Loading -> Box(Modifier.size(24.dp).background(Color.LightGray))
    OverlayNavigationVisual.Placeholder -> NavigationPlaceholder()
  }
}

@Composable
private fun NavigationPlaceholder() {
  Box(Modifier.size(24.dp).background(Color.LightGray).semantics { role = Role.Image })
}

/** Nav icons are drawn at 24 dp; decode for up to xxxhdpi so they stay sharp on any display. */
private val NAVIGATION_ICON_TARGET = OverlayImageTarget(96, 96)
