package dev.jasonpearson.automobile.ctrlproxy.prototype

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
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeDimension
import dev.jasonpearson.automobile.protocol.PrototypeImageNode
import dev.jasonpearson.automobile.protocol.PrototypeItem
import dev.jasonpearson.automobile.protocol.PrototypeStyle

/** Supplied by [PrototypeRuntimeContent]; null (previews, tests) draws every image as missing. */
internal val LocalPrototypeImageCache = compositionLocalOf<PrototypeImageCache?> { null }

/** Collected once by the runtime; direct cache providers collect locally when null. */
internal val LocalPrototypeImageVersion = compositionLocalOf<Long?> { null }

/** A [Bitmap] the cache can account for. */
class BitmapPrototypeImage(val bitmap: Bitmap) : PrototypeDecodedImage {
  val imageBitmap: ImageBitmap = bitmap.asImageBitmap()

  override val width: Int
    get() = bitmap.width

  override val height: Int
    get() = bitmap.height

  override val byteCount: Long
    get() = bitmap.allocationByteCount.toLong()
}

/**
 * [BitmapFactory] decoding with `inSampleSize` chosen by [prototypeImageSampleSize], so only a
 * display-sized bitmap is ever allocated (never the full-resolution one). Needs real Android bitmap
 * decoding, so it is verified on a device rather than in JVM unit tests; the sampling, caching and
 * fallback logic around it is unit tested with a fake decoder.
 */
class BitmapPrototypeImageDecoder(private val maxPixels: Long = DEFAULT_MAX_DECODED_PIXELS) :
  PrototypeImageDecoder {
  override fun decode(bytes: ByteArray, target: PrototypeImageTarget): PrototypeDecodedImage? =
    try {
      decodeSampled(bytes, target)
    } catch (error: OutOfMemoryError) {
      Log.w(TAG, "Prototype image decode ran out of memory (${bytes.size} encoded bytes)", error)
      null
    }

  private fun decodeSampled(
    bytes: ByteArray,
    target: PrototypeImageTarget,
  ): PrototypeDecodedImage? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
      Log.w(TAG, "Prototype image bytes are not decodable (${bytes.size} bytes)")
      return null
    }
    val sampleSize = prototypeImageSampleSize(bounds.outWidth, bounds.outHeight, target, maxPixels)
    if (!prototypeImageFitsBudget(bounds.outWidth, bounds.outHeight, sampleSize, maxPixels)) {
      // The sample size is capped, so a header claiming absurd dimensions stays over budget.
      Log.w(TAG, "Prototype image ${bounds.outWidth}x${bounds.outHeight} exceeds the decode budget")
      return null
    }
    val options = BitmapFactory.Options().apply { inSampleSize = sampleSize }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.let(::BitmapPrototypeImage)
  }

  companion object {
    /** 4 Mi pixels, 16 MiB as ARGB_8888: above a 1080x2400 screen (about 2.6 Mi pixels). */
    const val DEFAULT_MAX_DECODED_PIXELS = 4L * 1024 * 1024

    private const val TAG = "PrototypeImageDecoder"
  }
}

/**
 * The state to draw for [assetId] at [target]. Starts from the cache when it already has the answer
 * so a cached image shows on the first frame, decodes off the main thread otherwise, and reloads
 * whenever the store replaces, removes or clears an asset.
 */
@Composable
internal fun rememberPrototypeImage(
  assetId: String,
  target: PrototypeImageTarget,
): PrototypeImageState {
  val previous = remember { PrototypeImageDrawState() }
  val cache = LocalPrototypeImageCache.current
  if (cache == null) {
    previous.last = PrototypeImageState.Missing
    return previous.last
  }
  val version = LocalPrototypeImageVersion.current ?: cache.version.collectAsState().value
  val cached = remember(cache, assetId, target, version) { cache.peek(assetId, target) }
  val probe = LocalPrototypeRenderWorkProbe.current
  val result =
    if (cached != null) cached
    else {
      val loaded by
        produceState(previous.last, cache, assetId, target, version) {
          probe?.invoke(PrototypeRenderWork.IMAGE_LOAD_LAUNCH, assetId)
          value = cache.load(assetId, target)
        }
      loaded
    }
  previous.last = result
  return result
}

/** Survives producer key changes, including a cached answer replacing the producer branch. */
private class PrototypeImageDrawState {
  var last: PrototypeImageState = PrototypeImageState.Loading
}

/** The display size to decode for: the incoming constraint when bounded, else the screen. */
@Composable
private fun prototypeImageTarget(constraints: Constraints): PrototypeImageTarget {
  val density = LocalDensity.current
  val configuration = LocalConfiguration.current
  fun screenPx(dp: Int) = with(density) { dp.dp.roundToPx() }
  return PrototypeImageTarget(
    if (constraints.hasBoundedWidth) constraints.maxWidth
    else screenPx(configuration.screenWidthDp),
    if (constraints.hasBoundedHeight) constraints.maxHeight
    else screenPx(configuration.screenHeightDp),
  )
}

/**
 * Authored content dp size for eligible explicit dp axes can yield a different decode target from
 * the constraint-derived target when a parent is tighter. When they differ, the authored-size
 * target can only be larger.
 */
internal fun prototypeAuthoredImageSize(node: PrototypeRenderNode): DpSize? {
  if (node.role != "image") return null
  val style = node.style.source
  val width = (style.width as? PrototypeDimension.Dp)?.dp ?: return null
  val height = (style.height as? PrototypeDimension.Dp)?.dp ?: return null
  if (
    style.weight != null ||
      node.source?.anchor != null ||
      style.aspectRatio != null ||
      style.minWidth != null ||
      style.maxWidth != null ||
      style.minHeight != null ||
      style.maxHeight != null ||
      node.safeArea != null
  )
    return null
  val padding = style.padding
  return DpSize(
    (width - (padding?.start ?: 0.0) - (padding?.end ?: 0.0)).coerceAtLeast(0.0).toFloat().dp,
    (height - (padding?.top ?: 0.0) - (padding?.bottom ?: 0.0)).coerceAtLeast(0.0).toFloat().dp,
  )
}

/** An image at authored contentScale; both measurement paths share the exact drawn body. */
@Composable
internal fun PrototypeImageContent(node: PrototypeRenderNode, modifier: Modifier) {
  val source = node.source as? PrototypeImageNode ?: return
  if (prototypeAuthoredImageSize(node) != null) {
    val target = prototypeAuthoredImageTarget(node.style.source)
    Box(modifier.defaultMinSize(24.dp, 24.dp)) { PrototypeImageBody(node, source, target) }
  } else {
    LocalPrototypeRenderWorkProbe.current?.invoke(
      PrototypeRenderWork.IMAGE_SUBCOMPOSITION,
      node.identity,
    )
    BoxWithConstraints(modifier.defaultMinSize(24.dp, 24.dp)) {
      PrototypeImageBody(node, source, prototypeImageTarget(constraints))
    }
  }
}

/** Round each authored dimension and inset separately, exactly as the size/padding modifiers do. */
@Composable
private fun prototypeAuthoredImageTarget(style: PrototypeStyle): PrototypeImageTarget {
  val padding = style.padding
  return with(LocalDensity.current) {
    PrototypeImageTarget(
      (checkNotNull((style.width as? PrototypeDimension.Dp)).dp.toFloat().dp.roundToPx() -
          ((padding?.start ?: 0.0).toFloat().dp.roundToPx() +
            (padding?.end ?: 0.0).toFloat().dp.roundToPx()))
        .coerceAtLeast(0),
      (checkNotNull((style.height as? PrototypeDimension.Dp)).dp.toFloat().dp.roundToPx() -
          ((padding?.top ?: 0.0).toFloat().dp.roundToPx() +
            (padding?.bottom ?: 0.0).toFloat().dp.roundToPx()))
        .coerceAtLeast(0),
    )
  }
}

@Composable
private fun PrototypeImageBody(
  node: PrototypeRenderNode,
  source: PrototypeImageNode,
  target: PrototypeImageTarget,
) {
  val background =
    prototypeThemedColor(node.style.background, node.style.source.background)
      ?: prototypePlaceholderColor(MaterialTheme.colorScheme)
  val asset = prototypeModeValue(source.asset, LocalPrototypeDark.current)
  val state = rememberPrototypeImage(asset, target)
  val image = (state as? PrototypeImageState.Ready)?.image as? BitmapPrototypeImage
  if (image != null) {
    Image(
      rememberPrototypeImageBitmap(image, asset),
      contentDescription = null,
      modifier = fillAuthoredAxes(node.style.source),
      contentScale = prototypeContentScale(source.contentScale),
    )
  } else {
    Box(fillAuthoredAxes(node.style.source).background(background), Alignment.Center) {
      if (state != PrototypeImageState.Loading)
        Icon(
          Icons.Default.BrokenImage,
          contentDescription = null,
          tint = prototypePlaceholderContentColor(MaterialTheme.colorScheme),
        )
    }
  }
}

@Composable
private fun rememberPrototypeImageBitmap(image: BitmapPrototypeImage, asset: String): ImageBitmap {
  val probe = LocalPrototypeRenderWorkProbe.current
  return remember(image) {
    probe?.invoke(PrototypeRenderWork.IMAGE_BITMAP_WRAP, asset)
    image.imageBitmap
  }
}

/**
 * Crop and fill need the image to take the node's whole box; an axis the author left to wrap
 * content keeps the image's natural size on that axis.
 */
private fun fillAuthoredAxes(style: PrototypeStyle): Modifier {
  var modifier: Modifier = Modifier
  if (style.width.isSized()) modifier = modifier.fillMaxWidth()
  if (style.height.isSized()) modifier = modifier.fillMaxHeight()
  return modifier
}

private fun PrototypeDimension?.isSized() =
  this is PrototypeDimension.Fill || this is PrototypeDimension.Dp

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
