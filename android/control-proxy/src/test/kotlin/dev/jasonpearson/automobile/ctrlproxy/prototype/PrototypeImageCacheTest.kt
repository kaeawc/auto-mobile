package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeColumnNode
import dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement
import dev.jasonpearson.automobile.protocol.PrototypeImageNode
import dev.jasonpearson.automobile.protocol.PrototypeModeValue
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeWindow
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
private class FakeImage(override val byteCount: Long, val target: PrototypeImageTarget) :
  PrototypeDecodedImage {
  override val width: Int
    get() = target.widthPx

  override val height: Int
    get() = target.heightPx
}

/** Decodes to a [FakeImage] sized by [bytesPerImage]; null for ids listed in [undecodable]. */
private class FakeDecoder(var bytesPerImage: Long = 100) : PrototypeImageDecoder {
  val targets = mutableListOf<PrototypeImageTarget>()
  val undecodable = mutableSetOf<Int>()
  var onDecode: (() -> Unit)? = null

  override fun decode(bytes: ByteArray, target: PrototypeImageTarget): PrototypeDecodedImage? {
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
class PrototypeImageCacheTest {
  private val files = FakePrototypeAssetFiles()
  private val store = PrototypeAssetStore(files)
  private val decoder = FakeDecoder()
  private val dispatcher = CountingDispatcher()
  private val small = PrototypeImageTarget(100, 100)

  private fun cache(maxBytes: Long = 1_000) =
    PrototypeImageCache(store, decoder, maxBytes, dispatcher).also {
      store.setChangeListener(it::invalidate)
    }

  private fun upload(id: String, size: Int = 16) =
    store.put(id, "image/png", PrototypeAssetBytes.png(size))

  @Test
  fun `a stored asset decodes once off the caller and is then served from the cache`() = runTest {
    val cache = cache()
    upload("hero")
    assertNull(cache.peek("hero", small))
    val first = cache.load("hero", small)
    val second = cache.load("hero", small)
    assertTrue(first is PrototypeImageState.Ready)
    assertSame(
      (first as PrototypeImageState.Ready).image,
      (second as PrototypeImageState.Ready).image,
    )
    assertEquals(1, decoder.targets.size)
    assertEquals(1, dispatcher.dispatched)
    assertTrue(cache.peek("hero", small) is PrototypeImageState.Ready)
  }

  @Test
  fun `the decoder is asked for a power of two bucket and nearby sizes share it`() = runTest {
    val cache = cache()
    upload("hero")
    cache.load("hero", PrototypeImageTarget(600, 1100))
    cache.load("hero", PrototypeImageTarget(650, 1500))
    assertEquals(listOf(PrototypeImageTarget(1024, 2048)), decoder.targets)
    cache.load("hero", PrototypeImageTarget(2000, 1100))
    assertEquals(PrototypeImageTarget(2048, 2048), decoder.targets.last())
    assertEquals(2, cache.cachedCount)
  }

  @Test
  fun `an unknown id is missing without decoding`() = runTest {
    val cache = cache()
    assertEquals(PrototypeImageState.Missing, cache.peek("nope", small))
    assertEquals(PrototypeImageState.Missing, cache.load("nope", small))
    assertTrue(decoder.targets.isEmpty())
  }

  @Test
  fun `an asset the store lists but whose file the OS evicted is missing and not cached`() =
    runTest {
      val cache = cache()
      upload("hero")
      files.stored.clear() // Cache directory evicted: lookup still answers, read returns null.
      assertEquals("hero", store.lookup("hero")?.id)
      assertEquals(PrototypeImageState.Missing, cache.load("hero", small))
      assertTrue(decoder.targets.isEmpty())
      assertEquals(0, cache.cachedCount)
    }

  @Test
  fun `undecodable bytes are missing and not cached`() = runTest {
    val cache = cache()
    upload("bad", size = 17)
    decoder.undecodable += 17
    assertEquals(PrototypeImageState.Missing, cache.load("bad", small))
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
    assertTrue(cache.peek("a", small) is PrototypeImageState.Ready)
    assertNull(cache.peek("b", small))
    assertTrue(cache.peek("c", small) is PrototypeImageState.Ready)
  }

  @Test
  fun `an image larger than the whole cap is shown but not retained`() = runTest {
    val cache = cache(maxBytes = 250)
    upload("big")
    decoder.bytesPerImage = 300
    assertTrue(cache.load("big", small) is PrototypeImageState.Ready)
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
    assertTrue(cache.peek("other", small) is PrototypeImageState.Ready)
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
    assertEquals(PrototypeImageState.Missing, cache.peek("hero", small))
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
    val sessionStore = PrototypeAssetStore(files, session = { session })
    val cache = PrototypeImageCache(sessionStore, decoder, 1_000, dispatcher)
    sessionStore.setChangeListener(cache::invalidate)
    sessionStore.put("hero", "image/png", PrototypeAssetBytes.png())
    cache.load("hero", small)
    session = 2
    sessionStore.lookup("hero")
    assertEquals(0, cache.cachedCount)
  }

  @Test
  fun `uploading an id that was missing wakes placeholders showing it`() = runTest {
    val cache = cache()
    assertEquals(PrototypeImageState.Missing, cache.load("late", small))
    val before = cache.version.value
    upload("late")
    assertTrue(cache.version.value > before)
    assertTrue(cache.load("late", small) is PrototypeImageState.Ready)
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
    assertTrue(state is PrototypeImageState.Ready)
    assertEquals(2, decoder.targets.size)
    assertEquals(1, cache.cachedCount)
  }

  @Test
  fun `a decode that races a removal is not kept`() = runTest {
    val cache = cache()
    upload("hero")
    decoder.onDecode = { store.remove("hero") }
    assertEquals(PrototypeImageState.Missing, cache.load("hero", small))
    assertEquals(0, cache.cachedCount)
  }

  @Test
  fun `a put reaches the cache before it returns, even through a listener that reads the store`() =
    runTest {
      val cache = PrototypeImageCache(store, decoder, 1_000, dispatcher)
      var seenByListener: PrototypeAssetInfo? = null
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
      val sessionStore = PrototypeAssetStore(files, session = { session })
      val cache = PrototypeImageCache(sessionStore, decoder, 1_000, dispatcher)
      sessionStore.setChangeListener(cache::invalidate)
      val replies = mutableListOf<List<String>>()
      val sink =
        object : PrototypeResultSink {
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
        PrototypeController(
          FakePrototypeHost(),
          sink,
          lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
          clearAssets = { sessionStore.clear() },
          hasAsset = { sessionStore.lookup(it) != null },
          images = cache,
        )
      val spec =
        PrototypeSpec(
          "panel",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          root =
            PrototypeColumnNode(
              children =
                listOf(
                  PrototypeImageNode(asset = PrototypeModeValue.Single("a")),
                  PrototypeImageNode(asset = PrototypeModeValue.Single("b")),
                ),
            ),
        )
      sessionStore.put("a", "image/png", PrototypeAssetBytes.png())
      sessionStore.put("b", "image/png", PrototypeAssetBytes.png())
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
      assertEquals(PrototypeImageState.Missing, cache.peek("a", small))
    }

  @Test
  fun `sample size halves while both decoded dimensions stay at least the target`() {
    val target = PrototypeImageTarget(1080, 2400)
    assertEquals(1, prototypeImageSampleSize(1080, 2400, target, Long.MAX_VALUE))
    assertEquals(1, prototypeImageSampleSize(2000, 3000, target, Long.MAX_VALUE))
    assertEquals(2, prototypeImageSampleSize(2160, 4800, target, Long.MAX_VALUE))
    assertEquals(4, prototypeImageSampleSize(4320, 9600, target, Long.MAX_VALUE))
    assertEquals(1, prototypeImageSampleSize(100, 100, target, Long.MAX_VALUE))
  }

  @Test
  fun `sample size grows past the target when the pixel cap demands it`() {
    val target = PrototypeImageTarget(4000, 4000)
    assertEquals(1, prototypeImageSampleSize(4000, 4000, target, 16_000_000))
    assertEquals(2, prototypeImageSampleSize(4000, 4000, target, 5_000_000))
    assertEquals(4, prototypeImageSampleSize(4000, 4000, target, 1_000_000))
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
    val target = PrototypeImageTarget(1080, 2400)
    val sample = prototypeImageSampleSize(1_000_000, 1_000_000, target, 4L * 1024 * 1024)
    assertEquals(64, sample)
    assertTrue(!prototypeImageFitsBudget(1_000_000, 1_000_000, sample, 4L * 1024 * 1024))
    assertTrue(prototypeImageFitsBudget(4320, 9600, 4, 4L * 1024 * 1024))
  }
}
