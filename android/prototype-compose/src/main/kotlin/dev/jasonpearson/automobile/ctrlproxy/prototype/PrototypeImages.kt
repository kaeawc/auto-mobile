package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.exifinterface.media.ExifInterface
import dev.jasonpearson.automobile.protocol.PrototypeDimension
import dev.jasonpearson.automobile.protocol.PrototypeImageNode
import dev.jasonpearson.automobile.protocol.PrototypeStyle
import java.io.IOException

/** Supplied by [PrototypeRuntimeContent]; null (previews, tests) draws every image as missing. */
internal val LocalPrototypeImageCache = compositionLocalOf<PrototypeImageCache?> { null }

/** Collected once by the runtime; direct cache providers collect locally when null. */
internal val LocalPrototypeImageVersion = compositionLocalOf<Long?> { null }

/** A [Bitmap] the cache can account for. */
internal class BitmapPrototypeImage(val bitmap: Bitmap) : PrototypeDecodedImage {
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
 * display-sized bitmap is allocated within both pixel and byte budgets. EXIF orientation is applied
 * after sampling, within half the budget so the source and its transformed copy fit together; the
 * sizing and transform math can run without Android bitmap decoding.
 */
@InternalAutoMobilePrototypeApi
class BitmapPrototypeImageDecoder(
  private val maxPixels: Long = DEFAULT_MAX_DECODED_PIXELS,
  private val maxDecodedBytes: Long = DEFAULT_MAX_DECODED_BYTES,
) : PrototypeImageDecoder {
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
    // Bounds do not reliably report the eventual config. Reserve RGBA_F16's 8 bytes/pixel
    // even for an ARGB_8888 candidate: a high-bit-depth source can override inPreferredConfig.
    val orientation = imageOrientation(bytes)
    // The EXIF transform allocates its copy while the sampled source is still alive.
    val pixelBudget =
      prototypeImageTransformPixelBudget(
        prototypeImagePixelBudget(maxPixels, maxDecodedBytes, 8),
        orientation,
      )
    val decodeTarget =
      if (orientation in 5..8) PrototypeImageTarget(target.heightPx, target.widthPx) else target
    val sampleSize =
      prototypeImageSampleSize(bounds.outWidth, bounds.outHeight, decodeTarget, pixelBudget)
    if (!prototypeImageFitsBudget(bounds.outWidth, bounds.outHeight, sampleSize, pixelBudget)) {
      Log.w(TAG, "Prototype image has unreadable or over-budget dimensions")
      return null
    }
    val options = BitmapFactory.Options().apply { inSampleSize = sampleSize }
    val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: return null
    if (decoded.allocationByteCount.toLong() > maxDecodedBytes) {
      decoded.recycle()
      return null
    }
    val oriented = orient(decoded, orientation)
    if (oriented.allocationByteCount.toLong() > maxDecodedBytes) {
      oriented.recycle()
      return null
    }
    return BitmapPrototypeImage(oriented)
  }

  private fun imageOrientation(bytes: ByteArray): Int =
    try {
      bytes.inputStream().use {
        ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1)
      }
    } catch (_: IOException) {
      // Some supported bitmap formats carry no EXIF; their pixels already have normal orientation.
      1
    }

  private fun orient(bitmap: Bitmap, orientation: Int): Bitmap {
    if (orientation !in 2..8) return bitmap
    val matrix =
      Matrix().apply { setValues(prototypeImageOrientationMatrix(orientation).toFloatArray()) }
    try {
      return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, false)
    } finally {
      // The source has never been published to the renderer or cache.
      bitmap.recycle()
    }
  }

  companion object {
    /** 4 Mi pixels, 16 MiB as ARGB_8888: above a 1080x2400 screen (about 2.6 Mi pixels). */
    const val DEFAULT_MAX_DECODED_PIXELS = 4L * 1024 * 1024

    const val DEFAULT_MAX_DECODED_BYTES = 16L * 1024 * 1024

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
  val imageModifier =
    if (source.url != null) modifier.semantics(mergeDescendants = true) {} else modifier
  if (source.url == null && prototypeAuthoredImageSize(node) != null) {
    val target = prototypeAuthoredImageTarget(node.style.source)
    Box(imageModifier.defaultMinSize(24.dp, 24.dp)) { PrototypeImageBody(node, source, target) }
  } else {
    LocalPrototypeRenderWorkProbe.current?.invoke(
      PrototypeRenderWork.IMAGE_SUBCOMPOSITION,
      node.identity,
    )
    BoxWithConstraints(imageModifier.defaultMinSize(24.dp, 24.dp)) {
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
  if (source.url != null) {
    RemoteImageBody(node, source, target)
    return
  }
  val background =
    prototypeThemedColor(node.style.background, node.style.source.background)
      ?: prototypePlaceholderColor(MaterialTheme.colorScheme)
  val asset = source.asset?.let { prototypeModeValue(it, LocalPrototypeDark.current) }.orEmpty()
  val state = rememberPrototypeImage(asset, target)
  val image = (state as? PrototypeImageState.Ready)?.image as? BitmapPrototypeImage
  if (image != null) {
    Image(
      rememberPrototypeImageBitmap(image, asset),
      contentDescription = null,
      modifier =
        fillAuthoredAxes(node.style.source)
          .prototypeZoomable(source.zoomable)
          .prototypeImageTint(prototypeThemedColor(null, source.filter?.tint)),
      contentScale = prototypeContentScale(source.contentScale),
      colorFilter =
        source.filter?.let {
          prototypeImageColorFilter(it.saturation)
        },
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

internal val LocalPrototypeRemoteImages = compositionLocalOf<PrototypeRemoteImageLoader?> { null }
internal val LocalPrototypeRemoteImageActivity =
  compositionLocalOf<PrototypeRemoteImageActivity?> { null }

@Composable
private fun rememberRemoteImage(
  url: String,
  target: PrototypeImageTarget,
  enabled: Boolean,
): PrototypeImageState {
  val loader = LocalPrototypeRemoteImages.current.takeIf { enabled }
  val activity = LocalPrototypeRemoteImageActivity.current
  val session = remember(loader, url, target, activity) { PrototypeRemoteImageSession(activity) }
  androidx.compose.runtime.LaunchedEffect(session) { session.load(loader, url, target) }
  androidx.compose.runtime.DisposableEffect(session) { onDispose { session.close() } }
  return session.state.collectAsState().value
}

@Composable
private fun RemoteImageBody(
  node: PrototypeRenderNode,
  source: PrototypeImageNode,
  target: PrototypeImageTarget,
) {
  val state = rememberRemoteImage(checkNotNull(source.url), target, source.via != "host")
  Box(Modifier.semantics { stateDescription = prototypeRemoteImageDescription(state) }) {
    if (source.crossfade == true && LocalPrototypeMotion.current) {
      androidx.compose.animation.Crossfade(targetState = state, label = "prototype image") { shown
        ->
        RemoteImagePixels(node, source, target, shown)
      }
    } else RemoteImagePixels(node, source, target, state)
  }
}

@Composable
private fun RemoteImagePixels(
  node: PrototypeRenderNode,
  source: PrototypeImageNode,
  target: PrototypeImageTarget,
  state: PrototypeImageState,
) {
  val image = (state as? PrototypeImageState.Ready)?.image as? BitmapPrototypeImage
  if (image != null) {
    Image(
      image.imageBitmap,
      contentDescription = null,
      modifier =
        fillAuthoredAxes(node.style.source)
          .prototypeZoomable(source.zoomable)
          .prototypeImageTint(prototypeThemedColor(null, source.filter?.tint)),
      contentScale = prototypeContentScale(source.contentScale),
      colorFilter = source.filter?.let { prototypeImageColorFilter(it.saturation) },
    )
    return
  }
  val fallback =
    if (state == PrototypeImageState.Loading) source.placeholder
    else source.error ?: source.placeholder
  val asset = (fallback?.get("asset") as? kotlinx.serialization.json.JsonPrimitive)?.content
  val fallbackState = asset?.let { rememberPrototypeImage(it, target) }
  val fallbackImage = (fallbackState as? PrototypeImageState.Ready)?.image as? BitmapPrototypeImage
  if (fallbackImage != null) {
    Image(
      fallbackImage.imageBitmap,
      contentDescription = null,
      modifier = fillAuthoredAxes(node.style.source),
      contentScale = prototypeContentScale(source.contentScale),
    )
  } else {
    val color = (fallback?.get("color") as? kotlinx.serialization.json.JsonPrimitive)?.content
    Box(
      fillAuthoredAxes(node.style.source)
        .defaultMinSize(24.dp, 24.dp)
        .background(
          prototypeThemedColor(
            null,
            color?.let { dev.jasonpearson.automobile.protocol.PrototypeModeValue.Single(it) },
          ) ?: prototypePlaceholderColor(MaterialTheme.colorScheme),
        ),
    )
  }
}
