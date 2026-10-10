package dev.jasonpearson.automobile.ctrlproxy.prototype

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext

/** A decoded image the renderer can draw. Production wraps a Bitmap; tests use a plain fake. */
interface PrototypeDecodedImage {
  val width: Int
  val height: Int

  /** Heap the pixels occupy, which is what the cache's memory cap counts. */
  val byteCount: Long
}

/** The size, in pixels, an image will be shown at; the decoder downsamples to at least this. */
data class PrototypeImageTarget(val widthPx: Int, val heightPx: Int)

/** Decodes encoded PNG/JPEG/WebP bytes, or returns null when they cannot be decoded. */
fun interface PrototypeImageDecoder {
  /** Blocking and heavy: always called off the main thread. */
  fun decode(bytes: ByteArray, target: PrototypeImageTarget): PrototypeDecodedImage?
}

/** What an `image` node (or nav item image) should draw right now. */
sealed interface PrototypeImageState {
  /** The decode is still running; draw a neutral box, not the missing-asset placeholder. */
  data object Loading : PrototypeImageState

  data class Ready(val image: PrototypeDecodedImage) : PrototypeImageState

  /** Unknown id, unreadable file (the OS can evict the cache directory) or undecodable bytes. */
  data object Missing : PrototypeImageState
}

/**
 * Decoded-bitmap cache for prototype images. Decoding runs on [dispatcher], never the caller's
 * thread, and downsamples to the node's displayed size. Entries are keyed by asset id and a
 * power-of-two size bucket, so a small relayout reuses the bitmap while a much larger display
 * decodes again. Total decoded memory is capped at [maxDecodedBytes] (default
 * [DEFAULT_MAX_DECODED_BYTES]): the least recently used entries are evicted first, and a single
 * image bigger than the cap is shown but not retained.
 *
 * Whenever the store reports a replaced, removed or cleared asset the cache drops its decoded
 * copies right away, so a removed asset's pixels do not linger, and bumps [version] so composables
 * showing it reload. A decode that finishes after such a change is discarded and retried.
 *
 * The cache lock is never held while calling [source] or the decoder, and the store calls
 * [invalidate] only after releasing its own locks, so the two locks are never nested. A decode that
 * overlaps the window between a store change and its [invalidate] is covered by the epoch check.
 * Evicted bitmaps are not recycled: a composable may still be drawing one.
 */
class PrototypeImageCache(
  private val source: PrototypeAssetSource,
  private val decoder: PrototypeImageDecoder,
  private val maxDecodedBytes: Long = DEFAULT_MAX_DECODED_BYTES,
  private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
  private data class Key(val id: String, val widthBucket: Int, val heightBucket: Int)

  private val lock = Any()
  // Access-ordered, so the eldest entry is the least recently used one.
  private val entries = LinkedHashMap<Key, PrototypeDecodedImage>(16, 0.75f, true)
  private var decodedBytes = 0L
  private var epoch = 0L

  private val mutableVersion = MutableStateFlow(0L)

  /** Moves on every invalidation; key composables on it so they reload a changed asset. */
  val version: StateFlow<Long> = mutableVersion

  val cachedBytes: Long
    get() = synchronized(lock) { decodedBytes }

  val cachedCount: Int
    get() = synchronized(lock) { entries.size }

  /**
   * The answer if it is available without decoding: a cached image, or
   * [PrototypeImageState.Missing] for an id the store no longer has. Null means a [load] is needed.
   * Cheap enough for the main thread (a store lookup and a map read).
   */
  fun peek(id: String, target: PrototypeImageTarget): PrototypeImageState? {
    if (source.lookup(id) == null) return PrototypeImageState.Missing
    val image = synchronized(lock) { entries[keyFor(id, target)] }
    return image?.let { PrototypeImageState.Ready(it) }
  }

  /** Never returns [PrototypeImageState.Loading]; that is the caller's state while this runs. */
  suspend fun load(id: String, target: PrototypeImageTarget): PrototypeImageState {
    peek(id, target)?.let {
      return it
    }
    return withContext(dispatcher) {
      var state: PrototypeImageState? = null
      var attempts = 0
      while (state == null && attempts++ < MAX_DECODE_ATTEMPTS) state = decodeOnce(id, target)
      state ?: PrototypeImageState.Missing
    }
  }

  /** Null when the asset changed while decoding, so the result may be stale and is not kept. */
  private fun decodeOnce(id: String, target: PrototypeImageTarget): PrototypeImageState? {
    val key = keyFor(id, target)
    val startEpoch = synchronized(lock) { epoch }
    val image =
      source.read(id)?.let {
        decoder.decode(it, PrototypeImageTarget(key.widthBucket, key.heightBucket))
      } ?: return PrototypeImageState.Missing
    val current =
      synchronized(lock) {
        (epoch == startEpoch).also { if (it) retain(key, image) }
      }
    return if (current) PrototypeImageState.Ready(image) else null
  }

  /** Keeps [image] within the memory cap; an image bigger than the cap is shown but not kept. */
  private fun retain(key: Key, image: PrototypeDecodedImage) {
    if (image.byteCount > maxDecodedBytes) return
    entries.put(key, image)?.let { decodedBytes -= it.byteCount }
    decodedBytes += image.byteCount
    val eldest = entries.entries.iterator()
    while (decodedBytes > maxDecodedBytes && eldest.hasNext()) {
      val next = eldest.next()
      if (next.key == key) continue
      decodedBytes -= next.value.byteCount
      eldest.remove()
    }
  }

  /** [ids] null drops everything. Wired to [PrototypeAssetSource.setChangeListener]. */
  fun invalidate(ids: Set<String>?) {
    synchronized(lock) {
      epoch++
      val doomed = if (ids == null) entries.keys.toList() else entries.keys.filter { it.id in ids }
      doomed.forEach { key -> entries.remove(key)?.let { decodedBytes -= it.byteCount } }
    }
    mutableVersion.update { it + 1 }
  }

  private fun keyFor(id: String, target: PrototypeImageTarget) =
    Key(id, powerOfTwoAtLeast(target.widthPx), powerOfTwoAtLeast(target.heightPx))

  companion object {
    /**
     * 32 MiB of ARGB_8888 pixels: three full-screen 1080x2400 bitmaps (about 10 MiB each) or many
     * smaller ones. Well under the default 192 MiB app heap the prototype's other state shares.
     */
    const val DEFAULT_MAX_DECODED_BYTES = 32L * 1024 * 1024

    private const val MAX_DECODE_ATTEMPTS = 2
  }
}

/** Smallest power of two at or above [value] (minimum 1), bounding the number of cache buckets. */
internal fun powerOfTwoAtLeast(value: Int): Int {
  var bucket = 1
  while (bucket < value && bucket < MAX_BUCKET) bucket = bucket shl 1
  return bucket
}

private const val MAX_BUCKET = 1 shl 14

/**
 * The `inSampleSize` for decoding a [sourceWidth]x[sourceHeight] image for [target]: the largest
 * power of two that keeps both decoded dimensions at least the target's, then larger still while
 * the decoded pixel count would exceed [maxPixels]. A downsampled bitmap is never smaller than the
 * target unless the pixel cap forces it.
 */
internal fun prototypeImageSampleSize(
  sourceWidth: Int,
  sourceHeight: Int,
  target: PrototypeImageTarget,
  maxPixels: Long,
): Int {
  var sample = 1
  while (sample < MAX_SAMPLE_SIZE) {
    val width = sourceWidth / sample
    val height = sourceHeight / sample
    val halvable = width / 2 >= target.widthPx && height / 2 >= target.heightPx
    val tooBig = width.toLong() * height > maxPixels
    if (!halvable && !tooBig) break
    sample = sample shl 1
  }
  return sample
}

/** Whether decoding at [sampleSize] stays within [maxPixels]; false for absurd header sizes. */
internal fun prototypeImageFitsBudget(
  sourceWidth: Int,
  sourceHeight: Int,
  sampleSize: Int,
  maxPixels: Long,
): Boolean = (sourceWidth / sampleSize).toLong() * (sourceHeight / sampleSize) <= maxPixels

private const val MAX_SAMPLE_SIZE = 1 shl 6
