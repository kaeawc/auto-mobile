package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** `show` and `update` warn about referenced assets the device lacks, without failing. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class OverlayMissingAssetsTest {
  private data class Reply(val success: Boolean, val error: String?, val missing: List<String>)

  private val host = FakeInteractiveOverlayHost()
  private val store = OverlayAssetStore(FakeOverlayAssetFiles())
  private val replies = mutableListOf<Reply>()
  private val sink =
    object : OverlayResultSink {
      override suspend fun send(requestId: String?, success: Boolean, error: String?) {
        replies += Reply(success, error, emptyList())
      }

      override suspend fun sendWithMissingAssets(
        requestId: String?,
        success: Boolean,
        error: String?,
        missingAssets: List<String>,
      ) {
        replies += Reply(success, error, missingAssets)
      }
    }
  private val controller =
    OverlayController(
      host,
      sink,
      lifecycle = OverlayLifecycle(FakeOverlayTimer()),
      clearAssets = { store.clear() },
      hasAsset = { store.lookup(it) != null },
    )

  private fun spec(vararg assets: String) =
    OverlaySpec(
      "panel",
      OverlayWindow(OverlayFullscreenPlacement()),
      root = OverlayColumnNode(children = assets.map { OverlayImageNode(asset = it) }),
    )

  private fun upload(id: String) = store.put(id, "image/png", OverlayAssetBytes.png())

  @Test
  fun `show reports referenced assets that were never uploaded and still succeeds`() = runTest {
    upload("hero")
    controller.show("r1", spec("hero", "gone", "also-gone", "gone"))
    assertEquals(Reply(true, null, listOf("gone", "also-gone")), replies.last())
    assertTrue(host.isShowing)
  }

  @Test
  fun `show with every asset present sends the plain result`() = runTest {
    upload("hero")
    controller.show("r1", spec("hero"))
    assertEquals(Reply(true, null, emptyList()), replies.last())
  }

  @Test
  fun `show of a spec without images sends the plain result`() = runTest {
    controller.show("r1", spec())
    assertEquals(Reply(true, null, emptyList()), replies.last())
  }

  @Test
  fun `a state patch reports assets cleared since the show so the host can re-upload`() = runTest {
    upload("hero")
    controller.show("r1", spec("hero"))
    store.remove("hero")
    controller.update("r2", "panel", null, mapOf("k" to OverlayScalar.Text("v")))
    assertEquals(Reply(true, null, listOf("hero")), replies.last())
  }

  @Test
  fun `a spec update reports the replacement's missing assets`() = runTest {
    controller.show("r1", spec())
    controller.update("r2", "panel", spec("late"), null)
    assertEquals(Reply(true, null, listOf("late")), replies.last())
    upload("late")
    controller.update("r3", "panel", spec("late"), null)
    assertEquals(Reply(true, null, emptyList()), replies.last())
  }

  @Test
  fun `a failed show carries no missing list`() = runTest {
    val invalid =
      spec("gone").copy(root = OverlayTextNode(text = "x", style = OverlayStyle(alpha = 2.0)))
    controller.show("r1", invalid)
    assertFalse(replies.last().success)
    assertEquals(emptyList<String>(), replies.last().missing)
  }

  @Test
  fun `dismissal still clears the assets and reports no warning`() = runTest {
    upload("hero")
    controller.show("r1", spec("hero"))
    controller.dismiss("r2", "panel", null)
    assertEquals(Reply(true, null, emptyList()), replies.last())
    assertEquals(0, store.count)
  }
}
