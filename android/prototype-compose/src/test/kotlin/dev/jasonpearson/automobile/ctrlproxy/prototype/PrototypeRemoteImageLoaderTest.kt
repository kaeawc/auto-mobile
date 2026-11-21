package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.BuildConfig
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/** All delays use the test scheduler; no Android runtime, socket, disk, or real timer is used. */
@OptIn(ExperimentalCoroutinesApi::class)
class PrototypeRemoteImageLoaderTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val target = PrototypeImageTarget(100, 50)
  private val url = "https://images.example/private-token.png"
  private val image =
    object : PrototypeDecodedImage {
      override val width = 100
      override val height = 50
      override val byteCount = 20_000L
    }

  private class FakeRemoteImageLoader(
    private val latencyMs: Long = 10,
    var failure: Boolean = false,
    private val image: PrototypeDecodedImage,
  ) : PrototypeRemoteImageLoader {
    val requests = mutableListOf<Pair<String, PrototypeImageTarget>>()
    var active = 0
    var peak = 0

    override suspend fun load(url: String, target: PrototypeImageTarget): PrototypeImageState {
      requests += url to target
      active++
      peak = maxOf(peak, active)
      try {
        delay(latencyMs)
        if (failure) throw IOException("egress refused $url")
        return PrototypeImageState.Ready(image)
      } finally {
        active--
      }
    }
  }

  private class MemoryImageStore : PrototypeRemoteImageStore {
    val bytes = mutableMapOf<String, ByteArray>()

    override fun lookup(id: String) =
      bytes[id]?.let { PrototypeAssetInfo(id, "image/png", it.size) }

    override fun read(id: String) = bytes[id]

    override fun put(url: String, bytes: ByteArray) {
      this.bytes[url] = bytes
    }

    override fun setChangeListener(listener: PrototypeAssetChangeListener?) = Unit
  }

  @Test
  fun `release refuses loopback before store or transport`() = runTest {
    var downloads = 0
    val loader =
      CachedPrototypeRemoteImageLoader(
        {
          downloads++
          prototypeRemoteImageTestPng()
        },
        MemoryImageStore(),
        { _, _ -> image },
        dispatcher = UnconfinedTestDispatcher(testScheduler),
      )
    val state = loader.load("http://localhost:8080/i", target)
    assertEquals(BuildConfig.DEBUG, state is PrototypeImageState.Ready)
    assertEquals(if (BuildConfig.DEBUG) 1 else 0, downloads)
  }

  @Test
  fun `loader decodes once at sampled cache size and reuses URL across sizes and loader lifetimes`() =
    runTest {
      val bytes = prototypeRemoteImageTestPng()
      val store = MemoryImageStore()
      val requests = mutableListOf<String>()
      val targets = mutableListOf<PrototypeImageTarget>()
      val transport = PrototypeRemoteImageTransport {
        requests += it
        bytes
      }
      val decoder = PrototypeImageDecoder { encoded, size ->
        assertArrayEquals(bytes, encoded)
        targets += size
        image
      }
      fun loader() =
        CachedPrototypeRemoteImageLoader(
          transport,
          store,
          decoder,
          dispatcher = UnconfinedTestDispatcher(testScheduler),
        )
      val first = loader()
      assertTrue(first.load(url, target) is PrototypeImageState.Ready)
      assertTrue(first.load(url, target) is PrototypeImageState.Ready)
      assertEquals(listOf(PrototypeImageTarget(128, 64)), targets)
      assertTrue(first.load(url, target.copy(widthPx = 200)) is PrototypeImageState.Ready)
      assertEquals(PrototypeImageTarget(256, 64), targets.last())
      assertTrue(loader().load(url, target) is PrototypeImageState.Ready)
      assertEquals(listOf(url), requests)
      assertEquals(3, targets.size)
    }

  @Test
  fun `oversize and undecodable bytes become errors without retaining decoded pixels`() = runTest {
    for (bytes in
      listOf(
        ByteArray(PrototypeRemoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_DOWNLOAD_BYTES + 1),
        byteArrayOf(1),
      )) {
      var decodes = 0
      val loader =
        CachedPrototypeRemoteImageLoader(
          { bytes },
          MemoryImageStore(),
          { _, _ ->
            decodes++
            null
          },
          dispatcher = UnconfinedTestDispatcher(testScheduler),
        )
      val activity = PrototypeRemoteImageActivity()
      val session = PrototypeRemoteImageSession(activity)
      session.load(loader, url, target)
      assertEquals("error", prototypeRemoteImageDescription(session.state.value))
      assertEquals(PrototypeRemoteImageCounts(failed = 1), activity.counts())
      assertEquals(if (bytes.size == 1) 1 else 0, decodes)
      session.close()
    }
  }

  @Test
  fun `memory cache evicts decoded images above the injected heap budget`() = runTest {
    var decodes = 0
    var downloads = 0
    val loader =
      CachedPrototypeRemoteImageLoader(
        {
          downloads++
          prototypeRemoteImageTestPng()
        },
        MemoryImageStore(),
        { _, _ ->
          decodes++
          image
        },
        maxDecodedBytes = image.byteCount,
        dispatcher = UnconfinedTestDispatcher(testScheduler),
      )
    loader.load(url, target)
    loader.load("$url?second", target)
    loader.load(url, target)
    assertEquals(3, decodes)
    assertEquals(2, downloads)
  }

  @Test
  fun `at most six loads run including across different URLs and sizes`() = runTest {
    val fake = FakeRemoteImageLoader(image = image)
    val loader = LimitedPrototypeRemoteImageLoader(fake)
    val jobs =
      (0..7).map { index -> async { loader.load("$url?$index", target.copy(widthPx = index + 1)) } }
    runCurrent()
    assertEquals(6, fake.active)
    assertEquals(6, fake.requests.size)
    advanceTimeBy(10)
    runCurrent()
    assertEquals(8, fake.requests.size)
    advanceUntilIdle()
    assertTrue(jobs.awaitAll().all { it is PrototypeImageState.Ready })
    assertEquals(6, fake.peak)
    assertEquals(0, fake.active)
  }

  @Test
  fun `loading loaded error descriptions and counts never contain a URL`() = runTest {
    val fake = FakeRemoteImageLoader(image = image)
    val activity = PrototypeRemoteImageActivity()
    val session = PrototypeRemoteImageSession(activity)
    val job = launch { session.load(fake, url, target) }
    runCurrent()
    assertEquals("loading", prototypeRemoteImageDescription(session.state.value))
    assertEquals(PrototypeRemoteImageCounts(pending = 1), activity.counts())
    advanceUntilIdle()
    job.join()
    assertEquals("loaded", prototypeRemoteImageDescription(session.state.value))
    assertEquals(PrototypeRemoteImageCounts(loaded = 1), activity.counts())
    fake.failure = true
    launch { session.load(fake, url, target) }
    runCurrent()
    assertEquals("loading", prototypeRemoteImageDescription(session.state.value))
    advanceUntilIdle()
    assertEquals("error", prototypeRemoteImageDescription(session.state.value))
    assertEquals(PrototypeRemoteImageCounts(failed = 1), activity.counts())
    assertFalse(activity.counts().toString().contains(url))
    session.close()
    assertEquals(PrototypeRemoteImageCounts(), activity.counts())
  }

  @Test
  fun `cancelled loads release slots and pending counts`() = runTest {
    val fake = FakeRemoteImageLoader(image = image)
    val activity = PrototypeRemoteImageActivity()
    val loader = LimitedPrototypeRemoteImageLoader(fake)
    val sessions = List(7) { PrototypeRemoteImageSession(activity) }
    val jobs = sessions.map { launch { it.load(loader, url, target) } }
    runCurrent()
    assertEquals(PrototypeRemoteImageCounts(pending = 7), activity.counts())
    jobs.first().cancelAndJoin()
    runCurrent()
    assertEquals(6, fake.active)
    advanceUntilIdle()
    assertEquals(PrototypeRemoteImageCounts(loaded = 6), activity.counts())
    sessions.forEach { it.close() }
    assertEquals(PrototypeRemoteImageCounts(), activity.counts())
  }

  @Test
  fun `missing host transport refuses silently`() = runTest {
    val session = PrototypeRemoteImageSession(null)
    session.load(null, url, target)
    assertEquals("error", prototypeRemoteImageDescription(session.state.value))
  }

  @Test
  fun `URL policy runs before any transport and restricts development cleartext`() {
    assertTrue(prototypeRemoteImageUrlAllowed(url, false))
    for (bad in
      listOf(
        "file:///data/private",
        "content://private/image",
        "https://u:p@example.com/i",
        "https://example.com/ a",
        "https://example.com/\\a",
        "http://192.168.1.1/i",
        "https://example.com:0/i",
      )) {
      assertFalse(bad, prototypeRemoteImageUrlAllowed(bad, true))
    }
    for (loopback in
      listOf("http://localhost:8080/i", "http://127.0.0.1:8080/i", "http://[::1]:8080/i")) {
      assertTrue(prototypeRemoteImageUrlAllowed(loopback, true))
      assertFalse(prototypeRemoteImageUrlAllowed(loopback, false))
    }
  }

  @Test
  fun `bound URL is private while asset-only source remains unchanged`() {
    val remote =
      PrototypeImageNode(
        url = "{photo}",
        contentDescription = "{photo}",
        semantics = PrototypeSemantics(label = "{photo}", hint = "{photo}"),
      )
    val spec =
      PrototypeSpecValidator.validate(
        """{"id":"images","state":{"photo":"$url"},"window":{"placement":{"type":"fullscreen"}},"root":{"type":"image","url":"{photo}"}}""",
      ) as PrototypeSpecValidation.Success
    val mapped = mapPrototypeSpec(spec.spec.copy(root = remote)).root
    assertEquals(url, (mapped.source as PrototypeImageNode).url)
    assertNull(mapped.contentDescription)
    assertNull(mapped.semantics?.label)
    assertNull(mapped.semantics?.hint)
    val asset =
      PrototypeImageNode(asset = PrototypeModeValue.Single("logo"), contentDescription = "Brand")
    val mappedAsset = mapPrototypeSpec(spec.spec.copy(root = asset)).root
    assertEquals(asset, mappedAsset.source)
    assertEquals("Brand", mappedAsset.contentDescription)
  }
}

/** Trivially synthesized valid one-pixel RGBA PNG, with zlib data and computed chunk CRCs. */
internal fun prototypeRemoteImageTestPng(): ByteArray {
  val output = java.io.ByteArrayOutputStream()
  val writer = java.io.DataOutputStream(output)
  writer.write(byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10))
  fun chunk(name: String, bytes: ByteArray) {
    val type = name.toByteArray(Charsets.US_ASCII)
    writer.writeInt(bytes.size)
    writer.write(type)
    writer.write(bytes)
    val crc =
      java.util.zip.CRC32().apply {
        update(type)
        update(bytes)
      }
    writer.writeInt(crc.value.toInt())
  }
  val header = java.io.ByteArrayOutputStream()
  java.io.DataOutputStream(header).apply {
    writeInt(1)
    writeInt(1)
    write(byteArrayOf(8, 6, 0, 0, 0))
  }
  chunk("IHDR", header.toByteArray())
  val pixels = java.io.ByteArrayOutputStream()
  java.util.zip.DeflaterOutputStream(pixels).use { it.write(byteArrayOf(0, 0, 0, 0, 0)) }
  chunk("IDAT", pixels.toByteArray())
  chunk("IEND", ByteArray(0))
  return output.toByteArray()
}
