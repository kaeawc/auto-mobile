package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.ctrlproxy.models.TraversalOrderResult
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.ErrorResponse
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class FocusControllerTest {
  private class FakeTimer : TimeProvider {
    override fun currentTimeMillis() = 4_000L
  }

  private class FakeSender : FakeResultTransport() {
    val messages
      get() = sentFrames
  }

  private class FakeHost(private val scope: CoroutineScope) : FocusController.Host {
    var focusedNode: AccessibilityNodeInfo? = null
    var focusLookupError: Exception? = null
    var element: UIElementInfo? = null
    var traversal: TraversalOrderResult? = null
    var drawer: OverlayDrawer? = null

    override fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit) {
      scope.launch { block() }
    }

    override fun findAccessibilityFocusedNode(): AccessibilityNodeInfo? {
      focusLookupError?.let { throw it }
      return focusedNode
    }

    override fun extractFocusedElementInfo(node: AccessibilityNodeInfo) = element

    override fun extractTraversalOrder() = traversal

    override fun currentOverlayDrawer() = drawer
  }

  private val sender = FakeSender()
  private val errors = mutableListOf<ErrorResponse>()
  private val json = Json { encodeDefaults = true }
  private val timer = FakeTimer()

  private fun TestScope.setup(): Pair<FocusController, FakeHost> {
    val host = FakeHost(this)
    val controller =
      FocusController(
        host = host,
        perfProvider = PerfProvider.createForTesting(timer),
        timeProvider = timer,
        jsonCompact = json,
        resultSender =
          guardedResultSender(
            sender,
            ResultBroadcaster(broadcastError = { errors += it }, logError = { _, _ -> }),
          ),
      )
    return controller to host
  }

  private fun frame(): JsonObject = json.parseToJsonElement(sender.messages.last()).jsonObject

  @Test
  fun `no accessibility focus reports a null focused element`() = runTest {
    val (controller, _) = setup()

    controller.handleGetCurrentFocus("r1")
    advanceUntilIdle()

    assertEquals("current_focus_result", frame()["type"]!!.jsonPrimitive.content)
    assertEquals(JsonNull, frame()["focusedElement"])
    assertEquals(0L, frame()["totalTimeMs"]!!.jsonPrimitive.content.toLong())
  }

  @Test
  fun `a focused node is extracted into the result and recycled`() = runTest {
    val (controller, host) = setup()
    val node = mockk<AccessibilityNodeInfo>(relaxed = true)
    host.focusedNode = node
    host.element = UIElementInfo(text = "Email")

    controller.handleGetCurrentFocus("r1")
    advanceUntilIdle()

    assertEquals("Email", frame()["focusedElement"]!!.jsonObject["text"]!!.jsonPrimitive.content)
    verify(exactly = 1) { node.recycle() }
  }

  @Test
  fun `a failing focus lookup broadcasts the error frame`() = runTest {
    val (controller, host) = setup()
    host.focusLookupError = IllegalStateException("window gone")

    controller.handleGetCurrentFocus("r1")
    advanceUntilIdle()

    assertEquals("window gone", frame()["error"]!!.jsonPrimitive.content)
  }

  @Test
  fun `traversal order without any window reports no windows available`() = runTest {
    val (controller, _) = setup()

    controller.handleGetTraversalOrder("r1")
    advanceUntilIdle()

    assertEquals("No windows available", frame()["error"]!!.jsonPrimitive.content)
  }

  @Test
  fun `traversal order result is wrapped under the result key`() = runTest {
    val (controller, host) = setup()
    host.traversal = TraversalOrderResult(elements = listOf(UIElementInfo(text = "A")))

    controller.handleGetTraversalOrder("r1")
    advanceUntilIdle()

    assertEquals("traversal_order_result", frame()["type"]!!.jsonPrimitive.content)
    assertEquals(
      1,
      frame()["result"]!!.jsonObject["totalCount"]!!.jsonPrimitive.content.toInt(),
    )
  }

  @Test
  fun `highlight without an overlay drawer fails with the existing text`() = runTest {
    val (controller, _) = setup()

    controller.handleAddHighlight("r1", "h1", null)
    advanceUntilIdle()

    assertEquals("highlight_response", frame()["type"]!!.jsonPrimitive.content)
    assertFalse(frame()["success"]!!.jsonPrimitive.boolean)
    assertEquals("Overlay drawer not initialized", frame()["error"]!!.jsonPrimitive.content)
  }

  @Test
  fun `nothing is sent while the socket server is not running`() = runTest {
    val (controller, _) = setup()
    sender.running = false

    controller.handleGetCurrentFocus("r1")
    advanceUntilIdle()

    assertTrue(sender.messages.isEmpty())
  }
}
