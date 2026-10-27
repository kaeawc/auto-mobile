package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.RequestDrag
import dev.jasonpearson.automobile.protocol.RequestTapCoordinates
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.BeforeClass

internal open class CtrlProxyMessageHandlerFixtures {
  companion object {
    @BeforeClass
    @JvmStatic
    fun initializeDispatchClasses() = runTest {
      // Initialize coroutines and generated serializers once, outside per-test timings.
      // Each test still gets its own recording fake and handler.
      CtrlProxyMessageHandlerFixtures()
        .dispatch("""{"type":"request_select_all","requestId":"warmup"}""")
    }
  }

  protected val json = Json {
    classDiscriminator = "type"
    ignoreUnknownKeys = true
  }

  protected val actions = RecordingCtrlProxyActions()
  protected val logs = mutableListOf<String>()
  protected val handler = CtrlProxyMessageHandler(actions, log = { logs.add(it) })

  protected val calls: List<Pair<String, List<Any?>>>
    get() = actions.calls

  protected val lastCall: Pair<String, List<Any?>>
    get() = actions.calls.last()

  protected suspend fun dispatch(message: String) {
    handler.handleMessage(json.decodeFromString<WebSocketRequest>(message))
  }

  protected suspend fun assertTypedDispatch(
    message: String,
    expected: Pair<String, List<Any?>>,
  ) {
    val recording = RecordingCtrlProxyActions()
    val decoded = json.decodeFromString<WebSocketRequest>(message)
    val result = CtrlProxyMessageHandler(recording, sdkInt = { 30 }).handleMessage(decoded)
    assertNull(result)
    assertEquals(1, recording.calls.size)
    // Double tap intentionally retains its separate positional method.
    if (decoded !is RequestTapCoordinates || !decoded.doubleTap) {
      assertSame(decoded, recording.calls.single().second.single())
    }
    assertEquals(listOf(expected), recording.calls)
  }

  protected suspend fun assertResolvedDragDispatch(
    message: String,
    expected: Pair<String, List<Any?>>,
  ) {
    val recording = RecordingCtrlProxyActions()
    val decoded = json.decodeFromString<WebSocketRequest>(message) as RequestDrag
    val result = CtrlProxyMessageHandler(recording, sdkInt = { 30 }).handleMessage(decoded)
    assertNull(result)
    assertEquals(1, recording.calls.size)
    val recorded = recording.calls.single().second.single() as RequestDrag
    assertSame(decoded, recorded)
    // Resolution now happens in CtrlProxy. Retain the pinned effective-duration assertions while
    // also proving the handler forwards the original request with both legacy fields intact.
    assertEquals(
      expected,
      recording.calls.single().first to
        listOf<Any?>(
          recorded.copy(
            pressDurationMs = recorded.resolvedPressDurationMs,
            dragDurationMs = recorded.resolvedDragDurationMs,
            holdTime = null,
            duration = null,
          ),
        ),
    )
  }

  /** Dispatch and return the synchronous response (non-null only for the guard/error paths). */
  protected suspend fun dispatchForResponse(message: String): WebSocketResponse? =
    handler.handleMessage(json.decodeFromString<WebSocketRequest>(message))
}
