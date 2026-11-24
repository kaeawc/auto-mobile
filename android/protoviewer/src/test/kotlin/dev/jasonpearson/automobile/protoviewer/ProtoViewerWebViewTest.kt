package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeWebViewModule
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeSaveRequest
import java.net.InetAddress
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.Dns
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtoViewerWebViewTest {
  @Test
  fun reportsRegisteredCapability() {
    assertTrue(PrototypeWebViewModule.CAPABILITY in protoViewerMcpAbout(1, "test").capabilities)
  }

  @Test
  fun rejectsResolvedPrivateDestinationBeforeConnecting() {
    val dns = Dns { listOf(InetAddress.getByAddress(byteArrayOf(10, 0, 0, 1))) }
    val response = ViewerWebFetcher(dns).fetch("https://example.com/", "GET", emptyMap())
    assertEquals(403, response.status)
    assertTrue(response.destinationBlocked)
  }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun successfulResetAndDeleteBothWipeSharedWebData() = runTest {
    val store = LibraryStorage(FakePrototypeStorage())
    val repo =
      DirectoryLibraryRepository(FakeSavedStore(), FakeLibraryFiles(), store, IdGenerator { FIRST })
    assertTrue(
      repo.add(
        SavedPrototypeSaveRequest("same-spec-id", "Example", SPEC, emptyList()),
        LibrarySource.mcp,
        emptyList(),
      ) is LibraryResult.Success,
    )
    var wipes = 0
    val dispatcher = StandardTestDispatcher(testScheduler)
    Dispatchers.setMain(dispatcher)
    try {
      val services =
        ProtoViewerServices(
          repo,
          store,
          io = dispatcher,
          settings = FakeSettingsStore(),
          blocklist = FakeContentBlocklist(),
          webDataWiper = PrototypeWebDataWiper { wipes++ },
        )
      assertTrue(services.resetStorage(FIRST) is LibraryResult.Success)
      assertTrue(services.delete(FIRST) is LibraryResult.Success)
      assertEquals(2, wipes)
      assertTrue(services.resetStorage(FIRST) is LibraryResult.Failure)
      assertEquals(2, wipes)
    } finally {
      Dispatchers.resetMain()
    }
  }
}
