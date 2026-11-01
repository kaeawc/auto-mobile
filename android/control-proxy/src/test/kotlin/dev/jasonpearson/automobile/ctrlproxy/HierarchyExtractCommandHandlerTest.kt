package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.protocol.ErrorResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class HierarchyExtractCommandHandlerTest {
  /**
   * A service whose extraction returns a tree, nothing, or throws, and whose serializer can throw.
   * Every host call is logged in order so the delivery sequence can be checked.
   */
  private class FakeHost : HierarchyExtractCommandHandler.Host {
    var extracted: ViewHierarchy? =
      ViewHierarchy(packageName = "com.example.app", hierarchy = UIElementInfo(text = "Root"))
    var extractThrows: Throwable? = null
    var serializeThrows: RuntimeException? = null
    val calls = mutableListOf<String>()
    val results = mutableListOf<Triple<Boolean, String?, String?>>()
    val frames = mutableListOf<ErrorResponse?>()

    override fun cleanupUuidHierarchyFiles() {
      calls += "cleanup"
    }

    override fun extractHierarchy(
      textFilter: String?,
      disableAllFiltering: Boolean,
    ): ViewHierarchy? {
      calls += "extract:$textFilter:$disableAllFiltering"
      extractThrows?.let { throw it }
      return extracted
    }

    override fun serialize(hierarchy: ViewHierarchy): String {
      calls += "serialize"
      serializeThrows?.let { throw it }
      return "{json}"
    }

    override fun writeHierarchyToFile(
      hierarchy: ViewHierarchy,
      filename: String,
      serialized: String,
    ) {
      calls += "write:$filename:$serialized"
    }

    override suspend fun broadcastHierarchyUpdate(
      hierarchy: ViewHierarchy,
      serialized: String,
      requestId: String,
    ) {
      calls += "broadcast:$requestId:$serialized"
    }

    override fun releaseFrameContext(hierarchy: ViewHierarchy) {
      calls += "release"
    }

    override fun sendResult(success: Boolean, data: String?, error: String?) {
      calls += "result:$success"
      results += Triple(success, data, error)
    }

    override suspend fun sendErrorFrame(frame: ErrorResponse?) {
      calls += "frame"
      frames += frame
    }
  }

  private val host = FakeHost()
  private val handler = HierarchyExtractCommandHandler(host)

  private fun command(uuid: String? = "sync_1", text: String? = null, all: Boolean = false) =
    ExtractHierarchyCommand(uuid = uuid, textFilter = text, disableAllFiltering = all)

  @Test
  fun `a hierarchy is serialized once, written, pushed by uuid and acknowledged`() = runTest {
    handler.handle(command(all = true))

    assertEquals(
      listOf(
        "cleanup",
        "extract:null:true",
        "serialize",
        "write:hierarchy_sync_1.json:{json}",
        "broadcast:sync_1:{json}",
        "release",
        "result:true",
      ),
      host.calls,
    )
    assertEquals(
      "Hierarchy extracted successfully, saved as hierarchy_sync_1.json",
      host.results.single().second,
    )
    assertTrue(host.frames.isEmpty())
  }

  @Test
  fun `a text filter is passed through and named in the acknowledgement`() = runTest {
    handler.handle(command(text = "Login"))

    assertTrue("extract:Login:false" in host.calls)
    assertEquals(
      "Hierarchy extracted with text filter: 'Login', saved as hierarchy_sync_1.json",
      host.results.single().second,
    )
  }

  @Test
  fun `a missing uuid only gets the legacy failure result`() = runTest {
    for (uuid in listOf(null, "", "  ")) {
      host.calls.clear()
      host.results.clear()

      handler.handle(command(uuid = uuid))

      assertEquals(listOf("cleanup", "result:false"), host.calls)
      assertEquals("UUID parameter is required", host.results.single().third)
    }
  }

  @Test
  fun `an empty extraction fails with both the result and the correlated frame`() = runTest {
    host.extracted = null

    handler.handle(command())

    assertEquals(listOf("cleanup", "extract:null:false", "result:false", "frame"), host.calls)
    assertEquals(HierarchyExtractErrorFrames.NULL_HIERARCHY_ERROR, host.results.single().third)
    assertEquals("sync_1", host.frames.single()?.requestId)
  }

  @Test
  fun `a failed encode still releases the frame context and reports the failure`() = runTest {
    host.serializeThrows = IllegalArgumentException("NaN textSize")

    handler.handle(command())

    assertEquals(
      listOf("cleanup", "extract:null:false", "serialize", "release", "result:false", "frame"),
      host.calls,
    )
    assertEquals("sync_1", host.frames.single()?.requestId)
  }

  @Test
  fun `cancellation propagates without any failure reply`() = runTest {
    val cancellation = CancellationException("scope closed")
    host.extractThrows = cancellation

    try {
      handler.handle(command())
      fail("cancellation was swallowed")
    } catch (e: CancellationException) {
      assertSame(cancellation, e)
    }
    assertTrue(host.results.isEmpty() && host.frames.isEmpty())
  }

  @Test
  fun `another command action only cleans up`() = runTest {
    handler.handle(null)

    assertEquals(listOf("cleanup"), host.calls)
  }
}
