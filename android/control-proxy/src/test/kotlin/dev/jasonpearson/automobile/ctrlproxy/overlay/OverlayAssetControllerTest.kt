package dev.jasonpearson.automobile.ctrlproxy.overlay

import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class OverlayAssetControllerTest {
  private data class Reply(val requestId: String?, val success: Boolean, val error: String?)

  private val files = FakeOverlayAssetFiles()
  private val limits = OverlayAssetLimits(maxAssetBytes = 100, maxCount = 2, maxTotalBytes = 150)
  private val store = OverlayAssetStore(files, limits)
  private val replies = mutableListOf<Reply>()
  private var decodeCalls = 0
  private var decoder = OverlayBase64Decoder {
    decodeCalls++
    Base64.getDecoder().decode(it)
  }
  private val controller
    get() =
      OverlayAssetController(
        store,
        OverlayResultSink { id, success, error -> replies += Reply(id, success, error) },
        decoder,
      )

  private fun encoded(bytes: ByteArray = OverlayAssetBytes.png()): String =
    Base64.getEncoder().encodeToString(bytes)

  private fun lastReply() = replies.last()

  @Test
  fun `put stores the decoded bytes and answers once with the request id`() = runTest {
    val png = OverlayAssetBytes.png(40)
    controller.put("r1", "hero", "image/png", encoded(png))
    assertEquals(listOf(Reply("r1", true, null)), replies)
    assertEquals(OverlayAssetInfo("hero", "image/png", 40), store.lookup("hero"))
    assertTrue(png.contentEquals(store.read("hero")))
  }

  @Test
  fun `put of an existing id replaces it and still answers once`() = runTest {
    controller.put("r1", "hero", "image/png", encoded(OverlayAssetBytes.png(20)))
    controller.put("r2", "hero", "image/jpeg", encoded(OverlayAssetBytes.jpeg(30)))
    assertEquals(2, replies.size)
    assertTrue(replies.all { it.success })
    assertEquals(OverlayAssetInfo("hero", "image/jpeg", 30), store.lookup("hero"))
    assertEquals(1, store.count)
  }

  @Test
  fun `a null request id is passed through unchanged`() = runTest {
    controller.put(null, "hero", "image/png", encoded())
    assertNull(lastReply().requestId)
    assertTrue(lastReply().success)
  }

  @Test
  fun `invalid base64 is a failure reply and stores nothing`() = runTest {
    controller.put("r", "hero", "image/png", "not*base64!")
    assertEquals(1, replies.size)
    assertFalse(lastReply().success)
    assertEquals("r", lastReply().requestId)
    assertEquals("Overlay asset data is not valid base64.", lastReply().error)
    assertEquals(0, store.count)
  }

  @Test
  fun `oversized text is rejected before it is decoded`() = runTest {
    // 100 decoded bytes allow at most 136 base64 chars; 140 cannot decode within the limit.
    controller.put("r", "hero", "image/png", "A".repeat(140))
    assertEquals(1, replies.size)
    assertFalse(lastReply().success)
    assertTrue(lastReply().error.orEmpty(), lastReply().error.orEmpty().contains("100 byte limit"))
    assertEquals(0, decodeCalls)
  }

  @Test
  fun `decoded size is also checked exactly after decoding`() = runTest {
    controller.put("r", "hero", "image/png", encoded(OverlayAssetBytes.png(101)))
    assertFalse(lastReply().success)
    assertTrue(lastReply().error.orEmpty().contains("101 bytes"))
    assertEquals(1, decodeCalls)
    assertEquals(0, store.count)
  }

  @Test
  fun `store rejections reach the caller as one failure each`() = runTest {
    controller.put("a", "hero", "image/gif", encoded())
    assertTrue(lastReply().error.orEmpty().contains("Unsupported overlay asset MIME type"))
    controller.put("b", "", "image/png", encoded())
    assertTrue(lastReply().error.orEmpty().contains("id must be"))
    controller.put("c", "hero", "image/jpeg", encoded(OverlayAssetBytes.png()))
    assertTrue(lastReply().error.orEmpty().contains("not a valid image/jpeg"))
    assertEquals(listOf("a", "b", "c"), replies.map { it.requestId })
    assertTrue(replies.none { it.success })
    assertEquals(0, store.count)
  }

  @Test
  fun `full store rejects with a clear error and keeps existing assets`() = runTest {
    controller.put("1", "a", "image/png", encoded(OverlayAssetBytes.png(80)))
    controller.put("2", "b", "image/png", encoded(OverlayAssetBytes.png(80)))
    assertFalse(lastReply().success)
    assertTrue(lastReply().error.orEmpty().contains("storage full"))
    controller.put("3", "b", "image/png", encoded(OverlayAssetBytes.png(40)))
    controller.put("4", "c", "image/png", encoded(OverlayAssetBytes.png(10)))
    assertTrue(lastReply().error.orEmpty().contains("limit reached"))
    assertEquals(listOf("a", "b"), store.ids())
    assertEquals(listOf(true, false, true, false), replies.map { it.success })
  }

  @Test
  fun `a storage failure and an unexpected decoder failure each answer once`() = runTest {
    files.failWrites = true
    controller.put("w", "hero", "image/png", encoded())
    assertEquals(Reply("w", false, "Failed to store overlay asset."), lastReply())
    files.failWrites = false
    decoder = OverlayBase64Decoder { error("decoder blew up") }
    controller.put("d", "hero", "image/png", encoded())
    assertEquals(Reply("d", false, "decoder blew up"), lastReply())
    assertEquals(2, replies.size)
    assertEquals(0, store.count)
  }

  @Test
  fun `cancellation propagates instead of being reported as a failure`() = runTest {
    decoder = OverlayBase64Decoder { throw CancellationException("service stopping") }
    try {
      controller.put("c", "hero", "image/png", encoded())
      fail("cancellation must propagate")
    } catch (expected: CancellationException) {
      assertEquals("service stopping", expected.message)
    }
    assertTrue(replies.isEmpty())
  }

  @Test
  fun `replies never echo asset bytes`() = runTest {
    val payload = encoded(OverlayAssetBytes.png(90))
    controller.put("r", "hero", "image/jpeg", payload)
    controller.put("s", "hero", "image/png", payload + "AAAA")
    for (reply in replies) assertFalse(reply.error.orEmpty().contains(payload.take(24)))
  }

  @Test
  fun `remove deletes the asset and is idempotent for unknown ids`() = runTest {
    controller.put("p", "hero", "image/png", encoded())
    controller.remove("r1", "hero")
    assertEquals(Reply("r1", true, null), lastReply())
    assertNull(store.lookup("hero"))
    assertTrue(files.stored.isEmpty())
    controller.remove("r2", "hero")
    controller.remove("r3", "never-existed")
    assertEquals(listOf("p", "r1", "r2", "r3"), replies.map { it.requestId })
    assertTrue(replies.all { it.success })
  }

  @Test
  fun `remove frees room for a later put`() = runTest {
    controller.put("1", "a", "image/png", encoded(OverlayAssetBytes.png(80)))
    controller.remove("2", "a")
    controller.put("3", "b", "image/png", encoded(OverlayAssetBytes.png(80)))
    assertTrue(lastReply().success)
    assertNotNull(store.lookup("b"))
  }
}
