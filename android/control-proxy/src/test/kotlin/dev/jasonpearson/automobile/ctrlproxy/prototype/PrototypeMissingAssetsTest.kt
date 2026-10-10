package dev.jasonpearson.automobile.ctrlproxy.prototype

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
class PrototypeMissingAssetsTest {
  private data class Reply(val success: Boolean, val error: String?, val missing: List<String>)

  private val host = FakePrototypeHost()
  private val store = PrototypeAssetStore(FakePrototypeAssetFiles())
  private val replies = mutableListOf<Reply>()
  private val sink =
    object : PrototypeResultSink {
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
    PrototypeController(
      host,
      sink,
      lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      displays = PrototypeDisplayProvider { it == 2 },
      clearAssets = { store.clear() },
      hasAsset = { store.lookup(it) != null },
    )

  private fun spec(vararg assets: String) =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root =
        PrototypeColumnNode(
          children = assets.map { PrototypeImageNode(asset = PrototypeModeValue.Single(it)) },
        ),
    )

  private fun upload(id: String) = store.put(id, "image/png", PrototypeAssetBytes.png())

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
  fun `a same-id show reports assets cleared since the first show so the host can re-upload`() =
    runTest {
      upload("hero")
      controller.show("r1", spec("hero"))
      store.remove("hero")
      controller.show("r2", spec("hero"))
      assertEquals(Reply(true, null, listOf("hero")), replies.last())
    }

  @Test
  fun `a same-id show reports the replacement's missing assets`() = runTest {
    controller.show("r1", spec())
    controller.show("r2", spec("late"))
    assertEquals(Reply(true, null, listOf("late")), replies.last())
    upload("late")
    controller.show("r3", spec("late"))
    assertEquals(Reply(true, null, emptyList()), replies.last())
  }

  @Test
  fun `a failed show carries no missing list`() = runTest {
    val invalid =
      spec("gone").copy(root = PrototypeTextNode(text = "x", style = PrototypeStyle(alpha = 2.0)))
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

  @Test
  fun `a show on another display still reports its missing assets and targets that display`() =
    runTest {
      upload("hero")
      controller.show("r1", spec("hero", "gone"), displayId = 2)
      assertEquals(Reply(true, null, listOf("gone")), replies.last())
      assertEquals(2, host.requests.single().displayId)
    }

  @Test
  fun `a resend after the late upload keeps the display and clears the warning`() = runTest {
    controller.show("r1", spec("late"), displayId = 2)
    assertEquals(Reply(true, null, listOf("late")), replies.last())
    upload("late")
    controller.show("r2", spec("late"), displayId = 2)
    assertEquals(Reply(true, null, emptyList()), replies.last())
    assertEquals(listOf(2, 2), host.requests.map { it.displayId })
  }

  @Test
  fun `a same-id show on a shown display reports missing assets and stays on that display`() =
    runTest {
      controller.show("r1", spec(), displayId = 2)
      controller.show("r2", spec("late"))
      assertEquals(Reply(true, null, listOf("late")), replies.last())
      assertEquals(2, host.requests.last().displayId)
    }

  @Test
  fun `an unavailable display fails the show with no missing list`() = runTest {
    controller.show("r1", spec("gone"), displayId = 9)
    assertFalse(replies.last().success)
    assertEquals(emptyList<String>(), replies.last().missing)
    assertTrue(host.requests.isEmpty())
  }
}
