package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** One-shot captures take the first frame captured after their request (#17027). */
@OptIn(ExperimentalCoroutinesApi::class)
class FreshObservationFrameTest {
  private fun shot(timestamp: Long, base64: String? = "png-$timestamp") =
    ScreenshotStreamUpdate("a", timestamp, base64, 1, 1)

  private fun tree(timestamp: Long, packageName: String?) =
    HierarchyStreamUpdate("a", timestamp, data = null, packageName = packageName)

  private fun connected() = FakeObservationStream().apply { connect("a") }

  @Test
  fun `a fresh stream returns its first screenshot`() =
    runTest(UnconfinedTestDispatcher()) {
      val stream = connected()

      val capture = async { stream.awaitFreshScreenshot("a") }

      assertEquals(1, stream.observationRequestCount)
      assertEquals("a", stream.lastObservationDeviceId)
      assertEquals(listOf(FRESH_SCREENSHOT_INTERVAL_MS to null), stream.cadenceCalls)
      stream.emitScreenshot(shot(10))
      assertEquals(10L, capture.await().timestamp)
    }

  @Test
  fun `the replayed screenshot and anything older are never returned`() =
    runTest(UnconfinedTestDispatcher()) {
      val stream = connected()
      stream.emitScreenshot(shot(100))

      val capture = async { stream.awaitFreshScreenshot("a") }
      // Emitted before the request was sent, so older than the replayed frame.
      stream.emitScreenshot(shot(90))
      assertFalse(capture.isCompleted)

      // A different frame stamped in the same millisecond is new.
      stream.emitScreenshot(shot(100, "png-new"))
      assertEquals("png-new", capture.await().screenshotBase64)
    }

  @Test
  fun `a screenshot without image bytes is skipped`() =
    runTest(UnconfinedTestDispatcher()) {
      val stream = connected()

      val capture = async { stream.awaitFreshScreenshot("a") }
      stream.emitScreenshot(shot(1, base64 = ""))
      assertFalse(capture.isCompleted)

      stream.emitScreenshot(shot(2))
      assertEquals(2L, capture.await().timestamp)
    }

  @Test
  fun `a fresh hierarchy skips the replay and changes no cadence`() =
    runTest(UnconfinedTestDispatcher()) {
      val stream = connected()
      stream.emitHierarchy(tree(100, "com.stale"))

      val capture = async {
        stream.awaitFreshHierarchy("a") { !it.packageName.isNullOrBlank() }
      }
      stream.emitHierarchy(tree(101, null))
      assertFalse(capture.isCompleted)

      stream.emitHierarchy(tree(102, "com.fresh"))
      assertEquals("com.fresh", capture.await().packageName)
      assertEquals(1, stream.observationRequestCount)
      assertTrue(stream.cadenceCalls.isEmpty())
    }
}
