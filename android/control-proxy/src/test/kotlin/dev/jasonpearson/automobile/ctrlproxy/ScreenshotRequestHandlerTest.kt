package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHiddenCapture
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.ScreenshotResult
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ScreenshotRequestHandlerTest {
  private class FixedTimer : TimeProvider {
    override fun currentTimeMillis() = 4_242L
  }

  /**
   * A service with an active display, a frame-context token that a capture can advance (as a UI
   * change during the capture would), and a capture that succeeds, fails with a code, or throws.
   * Records which capture path ran and everything broadcast.
   */
  private class FakeHost : ScreenshotRequestHandler.Host {
    var running = true
    var frameContext = 7
    var advanceFrameDuringCapture = false
    var failureCode: Int? = null
    var captureFails = false
    var captureThrows: RuntimeException? = null
    var prototypeExcluded = true
    val captures = mutableListOf<String>()
    val responses = mutableListOf<WebSocketResponse>()
    val frames = mutableListOf<String>()

    override fun isRunning() = running

    override fun connectionCount() = 1

    override suspend fun broadcast(response: WebSocketResponse) {
      responses += response
    }

    override suspend fun broadcast(frame: String) {
      frames += frame
    }

    override fun currentFrameContext() = "epoch:$frameContext"

    override fun activeDisplayId() = 0

    override fun panelUniqueId(displayId: Int) = "panel-$displayId"

    override suspend fun capture(displayId: Int): ScreenshotCaptureOutcome {
      captures += "plain:$displayId"
      return outcome(displayId)
    }

    override suspend fun captureWithPrototypeHidden(
      displayId: Int,
    ): PrototypeHiddenCapture<ScreenshotCaptureOutcome> {
      captures += "hidden:$displayId"
      return PrototypeHiddenCapture(outcome(displayId), prototypeExcluded)
    }

    private fun outcome(displayId: Int): ScreenshotCaptureOutcome {
      captureThrows?.let { throw it }
      if (advanceFrameDuringCapture) frameContext++
      if (captureFails) return ScreenshotCaptureOutcome.Failure(failureCode)
      return ScreenshotCaptureOutcome.Success(
        ScreenshotCapturePayload(
          base64Image = "aW1n",
          rotation = 0,
          displayId = displayId,
          panelUniqueId = "panel-$displayId",
          captureDurationMs = 12L,
          encodeDurationMs = 3L,
          byteLength = 3,
          base64Length = 4,
        ),
      )
    }
  }

  private val host = FakeHost()
  private val errors = mutableListOf<ErrorResponse>()

  private fun handler(testScope: TestScope) =
    ScreenshotRequestHandler(
      host = host,
      asyncActionRunner =
        AsyncActionRunner(
          scope = CoroutineScope(UnconfinedTestDispatcher(testScope.testScheduler)),
          broadcastResponse = { errors += it as ErrorResponse },
          logError = { _, _ -> },
        ),
      timeProvider = FixedTimer(),
    )

  private fun screenshot(): ScreenshotResult = host.responses.single() as ScreenshotResult

  @Test
  fun `a capture on the active display carries the stable frame context`() = runTest {
    handler(this).broadcastScreenshot("req-1", displayId = null, hidePrototypes = false)

    assertEquals(listOf("plain:0"), host.captures)
    val result = screenshot()
    assertEquals("req-1", result.requestId)
    assertEquals("aW1n", result.data)
    assertEquals("jpeg", result.format)
    assertEquals(0, result.displayId)
    assertEquals(12L, result.screenshotCaptureDurationMs)
    assertEquals(4_242L, result.timestamp)
    assertEquals("epoch:7", result.frameContext)
    assertNull(result.prototypesHidden)
  }

  @Test
  fun `a frame that changed during the capture is not tagged`() = runTest {
    host.advanceFrameDuringCapture = true

    handler(this).broadcastScreenshot("req-2", displayId = null, hidePrototypes = false)

    assertNull(screenshot().frameContext)
  }

  @Test
  fun `an explicit display is captured instead of the active one`() = runTest {
    handler(this).broadcastScreenshot("req-3", displayId = 2, hidePrototypes = false)

    assertEquals(listOf("plain:2"), host.captures)
    assertEquals(2, screenshot().displayId)
  }

  @Test
  fun `hiding prototypes uses the hidden capture and reports whether they were excluded`() =
    runTest {
      handler(this).broadcastScreenshot("req-4", displayId = null, hidePrototypes = true)
      host.prototypeExcluded = false
      handler(this).broadcastScreenshot("req-5", displayId = null, hidePrototypes = true)

      assertEquals(listOf("hidden:0", "hidden:0"), host.captures)
      val (first, second) = host.responses.map { it as ScreenshotResult }
      assertEquals(true, first.prototypesHidden)
      assertEquals(false, second.prototypesHidden)
    }

  @Test
  fun `a rate-limited capture is reported distinctly from a generic failure`() = runTest {
    host.captureFails = true
    host.failureCode = AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT
    handler(this).broadcastScreenshot("req-6", displayId = 1, hidePrototypes = false)
    host.failureCode = null
    handler(this).broadcastScreenshot("req-7", displayId = 1, hidePrototypes = false)

    val (rateLimited, generic) = host.frames.map { Json.parseToJsonElement(it).jsonObject }
    assertEquals(CtrlProxyScreenshotWire.RATE_LIMITED_ERROR, rateLimited.text("error"))
    assertEquals(CtrlProxyScreenshotWire.GENERIC_ERROR, generic.text("error"))
    assertEquals("req-6", rateLimited.text("requestId"))
    assertEquals(1, rateLimited.getValue("displayId").jsonPrimitive.int)
    assertEquals("panel-1", rateLimited.text("panelUniqueId"))
    assertTrue(host.responses.isEmpty())
  }

  @Test
  fun `nothing is captured while the socket is down`() = runTest {
    host.running = false

    handler(this).broadcastScreenshot("req-8", displayId = null, hidePrototypes = false)

    assertTrue(host.captures.isEmpty())
    assertTrue(host.responses.isEmpty() && host.frames.isEmpty())
  }

  @Test
  fun `a throwing capture becomes a correlated error instead of a hang`() = runTest {
    host.captureThrows = IllegalStateException("display gone")

    handler(this).broadcastScreenshot("req-9", displayId = null, hidePrototypes = false)

    assertEquals("req-9", errors.single().requestId)
  }

  private fun kotlinx.serialization.json.JsonObject.text(key: String): String =
    getValue(key).jsonPrimitive.content
}
