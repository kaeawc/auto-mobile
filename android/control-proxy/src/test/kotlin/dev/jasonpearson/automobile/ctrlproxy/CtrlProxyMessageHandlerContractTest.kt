package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.RequestHierarchy
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class CtrlProxyMessageHandlerContractTest : CtrlProxyMessageHandlerFixtures() {
  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun `handler awaits action completion before returning`() = runTest {
    val release = CompletableDeferred<Unit>()
    val events = mutableListOf<String>()
    val handler =
      CtrlProxyMessageHandler(
        object : NoOpCtrlProxyActions() {
          override suspend fun requestHierarchy(request: RequestHierarchy) {
            events += "action started"
            release.await()
            events += "action completed"
          }
        },
      )
    val dispatch = launch {
      assertNull(handler.handleMessage(RequestHierarchy(requestId = "held")))
      events += "handler returned"
    }
    runCurrent()
    assertEquals(listOf("action started"), events)
    assertFalse(dispatch.isCompleted)
    release.complete(Unit)
    runCurrent()
    assertEquals(listOf("action started", "action completed", "handler returned"), events)
    assertTrue(dispatch.isCompleted)
  }

  // ---------------------------------------------------------------------------
  // Ahead-of-need: request_hit_test decodes but has no wired device action
  // ---------------------------------------------------------------------------

  @Test
  fun `request_hit_test is decoded but not dispatched to any action`() = runTest {
    dispatch("""{"type":"request_hit_test","requestId":"ht1","x":320,"y":720}""")
    assertTrue("no action should fire for the ahead-of-need type", calls.isEmpty())
    assertEquals(1, logs.size)
    assertTrue(logs[0], logs[0].contains("request_hit_test received"))
    assertTrue(logs[0], logs[0].contains("requestId=ht1"))
  }

  // ---------------------------------------------------------------------------
  // Fire-and-forget contract + partial construction
  // ---------------------------------------------------------------------------

  @Test
  fun `handleMessage returns null for every command (fire-and-forget)`() = runTest {
    // A spread across categories, including the branches that do extra work: shape conversion,
    // rule re-encoding, the ahead-of-need type, recording, and the subscriptionId-only unsubscribe.
    val messages =
      listOf(
        """{"type":"request_screenshot","requestId":"s1"}""",
        """{"type":"request_tap_coordinates","requestId":"t1","x":1,"y":2}""",
        """{"type":"add_highlight","requestId":"h1","id":"x","shape":{"type":"circle","bounds":{"x":0,"y":0,"width":1,"height":1}}}""",
        """{"type":"set_network_mock_rules","rules":[]}""",
        """{"type":"request_hit_test","requestId":"ht","x":1,"y":2}""",
        """{"type":"start_recording"}""",
        """{"type":"unsubscribe_storage","requestId":"u","subscriptionId":"a:b"}""",
      )
    for (message in messages) {
      val response = handler.handleMessage(json.decodeFromString<WebSocketRequest>(message))
      assertEquals("null expected for $message", null, response)
    }
  }

  @Test
  fun `no-op actions ignore commands without crashing`() = runTest {
    // NoOpCtrlProxyActions implements every action as a no-op — a decoded command must dispatch
    // cleanly (the compiler already guarantees every action is implemented).
    val noOpHandler = CtrlProxyMessageHandler(NoOpCtrlProxyActions(), log = { logs.add(it) })
    val messages =
      listOf(
        """{"type":"request_screenshot","requestId":"s1"}""",
        """{"type":"request_swipe","requestId":"sw1","x1":0,"y1":0,"x2":1,"y2":1}""",
        """{"type":"add_highlight","requestId":"h1","id":"x","shape":{"type":"circle","bounds":{"x":0,"y":0,"width":1,"height":1}}}""",
        """{"type":"set_network_mock_rules","rules":[]}""",
        """{"type":"start_recording"}""",
      )
    for (message in messages) {
      val response = noOpHandler.handleMessage(json.decodeFromString<WebSocketRequest>(message))
      assertEquals(null, response)
    }
    assertTrue("recording fake must be untouched by the no-op handler", calls.isEmpty())
  }
}
