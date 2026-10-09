package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.OverlayColumnNode
import dev.jasonpearson.automobile.protocol.OverlayFullscreenPlacement
import dev.jasonpearson.automobile.protocol.OverlayImageNode
import dev.jasonpearson.automobile.protocol.OverlaySpec
import dev.jasonpearson.automobile.protocol.OverlayWindow
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Runnable
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A decoded image without pixels: only the size the cache accounts for. */
private class FakeImage(override val byteCount: Long, val target: OverlayImageTarget) :
  OverlayDecodedImage {
  override val width: Int
    get() = target.widthPx

  override val height: Int
    get() = target.heightPx
}

/** Decodes to a [FakeImage] sized by [bytesPerImage]; null for ids listed in [undecodable]. */
private class FakeDecoder(var bytesPerImage: Long = 100) : OverlayImageDecoder {
  val targets = mutableListOf<OverlayImageTarget>()
  val undecodable = mutableSetOf<Int>()
  var onDecode: (() -> Unit)? = null

  override fun decode(bytes: ByteArray, target: OverlayImageTarget): OverlayDecodedImage? {
    targets += target
    onDecode?.invoke()
    return if (bytes.size in undecodable) null else FakeImage(bytesPerImage, target)
  }
}

/** Counts dispatches so a test can tell the decode left the caller's thread-of-control. */
private class CountingDispatcher : CoroutineDispatcher() {
  var dispatched = 0

  override fun dispatch(context: CoroutineContext, block: Runnable) {
    dispatched++
    block.run()
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class OverlayImageCacheTest {
  private val files = FakeOverlayAssetFiles()
  private val store = OverlayAssetStore(files)
  private val decoder = FakeDecoder()
  private val dispatcher = CountingDispatcher()
  private val small = OverlayImageTarget(100, 100)

  private fun cache(maxBytes: Long = 1_000) =
    OverlayImageCache(store, decoder, maxBytes, dispatcher).also {
      store.setChangeListener(it::invalidate)
    }

  private fun upload(id: String, size: Int = 16) =
    store.put(id, "image/png", OverlayAssetBytes.png(size))

  @Test
  fun `a stored asset decodes once off the caller and is then served from the cache`() = runTest {
    val cache = cache()
    upload("hero")
    assertNull(cache.peek("hero", small))
    val first = cache.load("hero", small)
    val second = cache.load("hero", small)
    assertTrue(first is OverlayImageState.Ready)
    assertSame((first as OverlayImageState.Ready).image, (second as OverlayImageState.Ready).image)
    assertEquals(1, decoder.targets.size)
    assertEquals(1, dispatcher.dispatched)
    assertTrue(cache.peek("hero", small) is OverlayImageState.Ready)
  }

  @Test
  fun `the decoder is asked for a power of two bucket and nearby sizes share it`() = runTest {
    val cache = cache()
    upload("hero")
    cache.load("hero", OverlayImageTarget(600, 1100))
    cache.load("hero", OverlayImageTarget(650, 1500))
    assertEquals(listOf(OverlayImageTarget(1024, 2048)), decoder.targets)
    cache.load("hero", OverlayImageTarget(2000, 1100))
    assertEquals(OverlayImageTarget(2048, 2048), decoder.targets.last())
    assertEquals(2, cache.cachedCount)
  }

  @Test
  fun `an unknown id is missing without decoding`() = runTest {
    val cache = cache()
    assertEquals(OverlayImageState.Missing, cache.peek("nope", small))
    assertEquals(OverlayImageState.Missing, cache.load("nope", small))
    assertTrue(decoder.targets.isEmpty())
  }

  @Test
  fun `an asset the store lists but whose file the OS evicted is missing and not cached`() =
    runTest {
      val cache = cache()
      upload("hero")
      files.stored.clear() // Cache directory evicted: lookup still answers, read returns null.
      assertEquals("hero", store.lookup("hero")?.id)
      assertEquals(OverlayImageState.Missing, cache.load("hero", small))
      assertTrue(decoder.targets.isEmpty())
      assertEquals(0, cache.cachedCount)
    }

  @Test
  fun `undecodable bytes are missing and not cached`() = runTest {
    val cache = cache()
    upload("bad", size = 17)
    decoder.undecodable += 17
    assertEquals(OverlayImageState.Missing, cache.load("bad", small))
    assertEquals(0, cache.cachedCount)
  }

  @Test
  fun `least recently used images are evicted to stay under the decoded memory cap`() = runTest {
    val cache = cache(maxBytes = 250)
    listOf("a", "b", "c").forEach { upload(it) }
    cache.load("a", small)
    cache.load("b", small)
    cache.peek("a", small) // Touch a so b is the eldest.
    cache.load("c", small)
    assertEquals(200, cache.cachedBytes)
    assertTrue(cache.peek("a", small) is OverlayImageState.Ready)
    assertNull(cache.peek("b", small))
    assertTrue(cache.peek("c", small) is OverlayImageState.Ready)
  }

  @Test
  fun `an image larger than the whole cap is shown but not retained`() = runTest {
    val cache = cache(maxBytes = 250)
    upload("big")
    decoder.bytesPerImage = 300
    assertTrue(cache.load("big", small) is OverlayImageState.Ready)
    assertEquals(0, cache.cachedBytes)
    assertEquals(0, cache.cachedCount)
  }

  @Test
  fun `replacing an asset drops its decoded copies and reloads the new bytes`() = runTest {
    val cache = cache()
    upload("hero")
    upload("other")
    cache.load("hero", small)
    cache.load("other", small)
    val before = cache.version.value
    upload("hero", size = 32)
    assertTrue(cache.version.value > before)
    assertNull(cache.peek("hero", small))
    assertTrue(cache.peek("other", small) is OverlayImageState.Ready)
    cache.load("hero", small)
    assertEquals(3, decoder.targets.size)
  }

  @Test
  fun `removing an asset frees its pixels and makes it missing`() = runTest {
    val cache = cache()
    upload("hero")
    cache.load("hero", small)
    store.remove("hero")
    assertEquals(0, cache.cachedBytes)
    assertEquals(OverlayImageState.Missing, cache.peek("hero", small))
  }

  @Test
  fun `clearing the store frees every decoded image`() = runTest {
    val cache = cache()
    upload("a")
    upload("b")
    cache.load("a", small)
    cache.load("b", small)
    val before = cache.version.value
    store.clear()
    assertEquals(0, cache.cachedBytes)
    assertEquals(0, cache.cachedCount)
    assertTrue(cache.version.value > before)
  }

  @Test
  fun `a new observer session drops decoded images through the store`() = runTest {
    var session = 1
    val sessionStore = OverlayAssetStore(files, session = { session })
    val cache = OverlayImageCache(sessionStore, decoder, 1_000, dispatcher)
    sessionStore.setChangeListener(cache::invalidate)
    sessionStore.put("hero", "image/png", OverlayAssetBytes.png())
    cache.load("hero", small)
    session = 2
    sessionStore.lookup("hero")
    assertEquals(0, cache.cachedCount)
  }

  @Test
  fun `uploading an id that was missing wakes placeholders showing it`() = runTest {
    val cache = cache()
    assertEquals(OverlayImageState.Missing, cache.load("late", small))
    val before = cache.version.value
    upload("late")
    assertTrue(cache.version.value > before)
    assertTrue(cache.load("late", small) is OverlayImageState.Ready)
  }

  @Test
  fun `a decode that races a replacement is discarded and redone`() = runTest {
    val cache = cache()
    upload("hero")
    var replaced = false
    decoder.onDecode = {
      if (!replaced) {
        replaced = true
        upload("hero", size = 32)
      }
    }
    val state = cache.load("hero", small)
    assertTrue(state is OverlayImageState.Ready)
    assertEquals(2, decoder.targets.size)
    assertEquals(1, cache.cachedCount)
  }

  @Test
  fun `a decode that races a removal is not kept`() = runTest {
    val cache = cache()
    upload("hero")
    decoder.onDecode = { store.remove("hero") }
    assertEquals(OverlayImageState.Missing, cache.load("hero", small))
    assertEquals(0, cache.cachedCount)
  }

  @Test
  fun `a put reaches the cache before it returns, even through a listener that reads the store`() =
    runTest {
      val cache = OverlayImageCache(store, decoder, 1_000, dispatcher)
      var seenByListener: OverlayAssetInfo? = null
      store.setChangeListener { ids ->
        seenByListener = ids?.firstOrNull()?.let(store::lookup)
        cache.invalidate(ids)
      }
      upload("hero")
      cache.load("hero", small)
      assertEquals(1, cache.cachedCount)
      val before = cache.version.value
      upload("hero", size = 32)
      assertEquals(32, seenByListener?.byteCount)
      assertTrue(cache.version.value > before)
      assertEquals(0, cache.cachedCount)
      assertNull(cache.peek("hero", small))
    }

  @Test
  fun `a session change drops the assets, wakes the cache and the next show lists them as missing`() =
    runTest {
      var session = 1
      val sessionStore = OverlayAssetStore(files, session = { session })
      val cache = OverlayImageCache(sessionStore, decoder, 1_000, dispatcher)
      sessionStore.setChangeListener(cache::invalidate)
      val replies = mutableListOf<List<String>>()
      val sink =
        object : OverlayResultSink {
          override suspend fun send(requestId: String?, success: Boolean, error: String?) {
            replies += emptyList<String>()
          }

          override suspend fun sendWithMissingAssets(
            requestId: String?,
            success: Boolean,
            error: String?,
            missingAssets: List<String>,
          ) {
            replies += missingAssets
          }
        }
      val controller =
        OverlayController(
          FakeInteractiveOverlayHost(),
          sink,
          lifecycle = OverlayLifecycle(FakeOverlayTimer()),
          clearAssets = { sessionStore.clear() },
          hasAsset = { sessionStore.lookup(it) != null },
          images = cache,
        )
      val spec =
        OverlaySpec(
          "panel",
          OverlayWindow(OverlayFullscreenPlacement()),
          root =
            OverlayColumnNode(
              children = listOf(OverlayImageNode(asset = "a"), OverlayImageNode(asset = "b")),
            ),
        )
      sessionStore.put("a", "image/png", OverlayAssetBytes.png())
      sessionStore.put("b", "image/png", OverlayAssetBytes.png())
      cache.load("a", small)
      cache.load("b", small)
      controller.show("r1", spec)
      assertEquals(emptyList<String>(), replies.last())
      val before = cache.version.value

      session = 2 // The observer reconnected; nothing has touched the store yet.
      controller.show("r2", spec)

      assertEquals(listOf("a", "b"), replies.last())
      assertTrue(cache.version.value > before)
      assertEquals(0, cache.cachedCount)
      assertEquals(0L, cache.cachedBytes)
      assertEquals(OverlayImageState.Missing, cache.peek("a", small))
    }

  @Test
  fun `sample size halves while both decoded dimensions stay at least the target`() {
    val target = OverlayImageTarget(1080, 2400)
    assertEquals(1, overlayImageSampleSize(1080, 2400, target, Long.MAX_VALUE))
    assertEquals(1, overlayImageSampleSize(2000, 3000, target, Long.MAX_VALUE))
    assertEquals(2, overlayImageSampleSize(2160, 4800, target, Long.MAX_VALUE))
    assertEquals(4, overlayImageSampleSize(4320, 9600, target, Long.MAX_VALUE))
    assertEquals(1, overlayImageSampleSize(100, 100, target, Long.MAX_VALUE))
  }

  @Test
  fun `sample size grows past the target when the pixel cap demands it`() {
    val target = OverlayImageTarget(4000, 4000)
    assertEquals(1, overlayImageSampleSize(4000, 4000, target, 16_000_000))
    assertEquals(2, overlayImageSampleSize(4000, 4000, target, 5_000_000))
    assertEquals(4, overlayImageSampleSize(4000, 4000, target, 1_000_000))
  }

  @Test
  fun `size buckets are powers of two with a floor of one`() {
    assertEquals(1, powerOfTwoAtLeast(0))
    assertEquals(1, powerOfTwoAtLeast(1))
    assertEquals(128, powerOfTwoAtLeast(96))
    assertEquals(1024, powerOfTwoAtLeast(1024))
    assertEquals(2048, powerOfTwoAtLeast(1025))
  }

  @Test
  fun `an absurd header size stays over budget at the capped sample size`() {
    val target = OverlayImageTarget(1080, 2400)
    val sample = overlayImageSampleSize(1_000_000, 1_000_000, target, 4L * 1024 * 1024)
    assertEquals(64, sample)
    assertTrue(!overlayImageFitsBudget(1_000_000, 1_000_000, sample, 4L * 1024 * 1024))
    assertTrue(overlayImageFitsBudget(4320, 9600, 4, 4L * 1024 * 1024))
  }
}
