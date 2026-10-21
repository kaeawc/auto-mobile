package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SavedPrototypeScreenStateTest {
  private val store = FakeSavedPrototypeStore()

  @Test
  fun `every store result maps to a typed screen without raw messages`() = runBlocking {
    val loaded = savedPrototypeFixture()
    val cases =
      listOf(
        loaded to SavedPrototypeScreenState.Ready(loaded),
        SavedPrototypeLoadResult.NotFound to SavedPrototypeScreenState.NotSaved,
        SavedPrototypeLoadResult.Corrupt("private/path") to SavedPrototypeScreenState.Corrupt,
        SavedPrototypeLoadResult.UnsupportedFormat(7) to SavedPrototypeScreenState.Unsupported(7),
      )
    for ((result, expected) in cases) {
      store.loadResult = result
      assertEquals(expected, loadSavedPrototypeState("panel", store) { true })
    }
    assertEquals(List(cases.size) { "panel" }, store.loadCalls)
  }

  @Test
  fun `locked and missing id never call the store`() = runBlocking {
    assertEquals(
      SavedPrototypeScreenState.Locked,
      loadSavedPrototypeState("panel", store) { false },
    )
    for (id in listOf(null, "", "  ")) {
      assertEquals(
        SavedPrototypeScreenState.MissingId,
        loadSavedPrototypeState(id, store) { false },
      )
    }
    assertTrue(store.loadCalls.isEmpty())
  }

  @Test
  fun `unexpected store exception returns corrupt`() = runBlocking {
    store.loadFailure = IOException("private/path")
    assertEquals(
      SavedPrototypeScreenState.Corrupt,
      loadSavedPrototypeState("panel", store) { true },
    )
  }
}
