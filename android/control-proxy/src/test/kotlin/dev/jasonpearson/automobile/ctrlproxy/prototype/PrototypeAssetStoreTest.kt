package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.OverlayAssetContract
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class OverlayAssetStoreTest {
  private val files = FakeOverlayAssetFiles()
  private val limits =
    OverlayAssetLimits(maxAssetBytes = 100, maxCount = 3, maxTotalBytes = 250, maxIdLength = 8)
  private val store = OverlayAssetStore(files, limits)

  private fun put(id: String, size: Int = 20, mime: String = "image/png") =
    store.put(id, mime, OverlayAssetBytes.png(size))

  private fun assertRejected(
    reason: OverlayAssetRejection,
    result: OverlayAssetPutResult,
    messagePart: String? = null,
  ) {
    val rejected = result as OverlayAssetPutResult.Rejected
    assertEquals(rejected.message, reason, rejected.reason)
    if (messagePart != null) assertTrue(rejected.message, rejected.message.contains(messagePart))
  }

  @Test
  fun `defaults come from the shared contract`() {
    val defaults = OverlayAssetLimits()
    assertEquals(4 * 1024 * 1024, defaults.maxAssetBytes)
    assertEquals(32, defaults.maxCount)
    assertEquals(16 * 1024 * 1024, defaults.maxTotalBytes)
    assertEquals(256, defaults.maxIdLength)
    assertEquals(2 * 1024 * 1024, defaults.maxFontBytes)
    assertEquals(
      setOf("image/png", "image/jpeg", "image/webp", "font/ttf", "font/otf"),
      defaults.mimeTypes,
    )
    assertEquals(OverlayAssetContract.MAX_OVERLAY_ASSET_BYTES, defaults.maxAssetBytes)
  }

  @Test
  fun `stores each allowed format and exposes info plus bytes to the renderer`() {
    val png = OverlayAssetBytes.png(30)
    val result = store.put("a", "image/png", png) as OverlayAssetPutResult.Stored
    assertFalse(result.replaced)
    assertEquals(OverlayAssetInfo("a", "image/png", 30), result.info)
    assertEquals(OverlayAssetInfo("a", "image/png", 30), store.lookup("a"))
    assertArrayEquals(png, store.read("a"))
    assertTrue(
      store.put("b", "image/jpeg", OverlayAssetBytes.jpeg()) is OverlayAssetPutResult.Stored,
    )
    assertTrue(
      store.put("c", "image/webp", OverlayAssetBytes.webp()) is OverlayAssetPutResult.Stored,
    )
    assertEquals(3, store.count)
    assertEquals(listOf("a", "b", "c"), store.ids())
  }

  @Test
  fun `unknown ids look up as null so the renderer can show a placeholder`() {
    assertNull(store.lookup("missing"))
    assertNull(store.read("missing"))
  }

  @Test
  fun `replace by id swaps bytes and metadata and frees the old file`() {
    put("a", 20)
    val first = files.stored.keys.single()
    val replacement = OverlayAssetBytes.jpeg(40)
    val result = store.put("a", "image/jpeg", replacement) as OverlayAssetPutResult.Stored
    assertTrue(result.replaced)
    assertEquals(1, store.count)
    assertEquals(40L, store.totalByteCount)
    assertEquals("image/jpeg", store.lookup("a")?.mimeType)
    assertArrayEquals(replacement, store.read("a"))
    assertEquals(1, files.stored.size)
    assertFalse(files.stored.containsKey(first))
  }

  @Test
  fun `replacement is judged by its net size and may fill the store`() {
    put("a", 100)
    put("b", 100)
    put("c", 50) // total 250, exactly full
    // Growing "c" to 100 would reach 300: rejected, and the old asset is intact.
    assertRejected(OverlayAssetRejection.TOTAL_LIMIT, put("c", 100))
    assertEquals(50, store.lookup("c")?.byteCount)
    assertEquals(250L, store.totalByteCount)
    // Shrinking a different asset is a net decrease and fits.
    assertTrue(put("a", 60) is OverlayAssetPutResult.Stored)
    assertEquals(210L, store.totalByteCount)
  }

  @Test
  fun `a replacement at the count limit is not a new asset`() {
    put("a")
    put("b")
    put("c")
    assertTrue(put("b", 30) is OverlayAssetPutResult.Stored)
    assertEquals(3, store.count)
  }

  @Test
  fun `count limit rejects a new id and keeps every existing asset`() {
    put("a")
    put("b")
    put("c")
    assertRejected(OverlayAssetRejection.COUNT_LIMIT, put("d"), "remove one first")
    assertEquals(listOf("a", "b", "c"), store.ids())
    assertEquals(3, files.stored.size)
  }

  @Test
  fun `total byte limit rejects instead of evicting`() {
    put("a", 100)
    put("b", 100)
    assertRejected(OverlayAssetRejection.TOTAL_LIMIT, put("c", 51), "remove an asset first")
    assertEquals(listOf("a", "b"), store.ids())
    assertEquals(200L, store.totalByteCount)
    assertTrue(put("c", 50) is OverlayAssetPutResult.Stored)
  }

  @Test
  fun `per asset size boundary is exact`() {
    assertTrue(put("a", 100) is OverlayAssetPutResult.Stored)
    assertRejected(OverlayAssetRejection.TOO_LARGE, put("b", 101))
    assertNull(store.lookup("b"))
  }

  @Test
  fun `empty data is rejected`() {
    assertRejected(OverlayAssetRejection.EMPTY, store.put("a", "image/png", ByteArray(0)))
  }

  @Test
  fun `only png jpeg and webp are accepted and matching is exact`() {
    for (mime in
      listOf("image/gif", "image/svg+xml", "IMAGE/PNG", "image/png ", "", "text/plain")) {
      assertRejected(OverlayAssetRejection.UNSUPPORTED_MIME_TYPE, put("a", mime = mime))
    }
    assertEquals(0, store.count)
  }

  @Test
  fun `bytes must match the declared format`() {
    assertRejected(
      OverlayAssetRejection.CONTENT_MISMATCH,
      store.put("a", "image/jpeg", OverlayAssetBytes.png()),
    )
    assertRejected(
      OverlayAssetRejection.CONTENT_MISMATCH,
      store.put("a", "image/png", ByteArray(32)),
    )
    assertRejected(
      OverlayAssetRejection.CONTENT_MISMATCH,
      store.put("a", "image/webp", OverlayAssetBytes.png()),
    )
    // A RIFF container that is not WebP.
    val wave = OverlayAssetBytes.webp()
    "WAVE".forEachIndexed { i, c -> wave[8 + i] = c.code.toByte() }
    assertRejected(OverlayAssetRejection.CONTENT_MISMATCH, store.put("a", "image/webp", wave))
    assertRejected(
      OverlayAssetRejection.CONTENT_MISMATCH,
      store.put("a", "image/png", ByteArray(3)),
    )
    assertEquals(0, store.count)
  }

  @Test
  fun `ids are nonempty and bounded but otherwise opaque`() {
    assertRejected(OverlayAssetRejection.INVALID_ID, put(""))
    assertRejected(OverlayAssetRejection.INVALID_ID, put("123456789"))
    val roomy = OverlayAssetStore(files, limits.copy(maxCount = 10, maxTotalBytes = 1000))
    for (id in listOf("12345678", "variantb", "../etc", "a/b", "☃")) {
      assertTrue(
        id,
        roomy.put(id, "image/png", OverlayAssetBytes.png()) is OverlayAssetPutResult.Stored,
      )
    }
    // No id ever reaches the file system: file names are store-generated.
    assertTrue(files.stored.keys.all { it.matches(Regex("asset-[0-9]+")) })
  }

  @Test
  fun `a failed write is a clear rejection that leaves the store unchanged`() {
    put("a", 20)
    files.failWrites = true
    val result = put("a", 30)
    assertRejected(OverlayAssetRejection.STORAGE_FAILURE, result, "Failed to store")
    assertEquals(20, store.lookup("a")?.byteCount)
    assertEquals(20L, store.totalByteCount)
    assertEquals(1, files.stored.size)
    files.failWrites = false
    assertTrue(put("a", 30) is OverlayAssetPutResult.Stored)
  }

  @Test
  fun `a failed read yields null rather than throwing`() {
    put("a")
    files.failReads = true
    assertNull(store.read("a"))
    assertNotNull(store.lookup("a"))
  }

  @Test
  fun `remove is idempotent and reclaims space`() {
    put("a", 100)
    put("b", 100)
    assertTrue(store.remove("a"))
    assertFalse(store.remove("a"))
    assertFalse(store.remove("never-existed"))
    assertEquals(100L, store.totalByteCount)
    assertEquals(1, files.stored.size)
    assertNull(store.lookup("a"))
    assertTrue(put("c", 100) is OverlayAssetPutResult.Stored)
  }

  @Test
  fun `clear drops assets and leaves a usable store`() {
    put("a")
    put("b")
    store.clear()
    assertEquals(0, store.count)
    assertEquals(0L, store.totalByteCount)
    assertTrue(files.stored.isEmpty())
    assertNull(store.lookup("a"))
    assertTrue(put("a") is OverlayAssetPutResult.Stored)
  }

  @Test
  fun `purging leftovers removes a previous process's files`() {
    files.stored["orphan-from-last-process"] = ByteArray(4)
    store.purgeLeftovers()
    assertTrue(files.stored.isEmpty())
    assertEquals(1, files.deleteAllCalls)
  }

  @Test
  fun `encoded length cap matches the largest legal asset`() {
    // 100 decoded bytes encode to 136 base64 chars (ceil(100 / 3) * 4).
    assertEquals(136L, limits.maxEncodedLength)
  }
}
