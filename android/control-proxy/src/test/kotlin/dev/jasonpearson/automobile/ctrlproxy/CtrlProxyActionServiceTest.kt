package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService
import dev.jasonpearson.automobile.ctrlproxy.prototype.FakePrototypeHost
import dev.jasonpearson.automobile.ctrlproxy.prototype.FakePrototypeTimer
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeController
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeLifecycle
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeResultSink
import dev.jasonpearson.automobile.protocol.RequestGlobalAction
import dev.jasonpearson.automobile.protocol.RequestHierarchy
import dev.jasonpearson.automobile.protocol.RequestImeAction
import dev.jasonpearson.automobile.protocol.RequestScreenshot
import dev.jasonpearson.automobile.protocol.RequestSetText
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.websocket.CloseReason
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers

/** Service-level differences that the Android-free dispatch recorder cannot observe. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class CtrlProxyActionServiceTest {
  private lateinit var fixture: CtrlProxyGestureServiceFixture
  private val json = Json { ignoreUnknownKeys = true }

  @Before
  fun setUp() {
    fixture = CtrlProxyGestureServiceFixture()
  }

  @After
  fun tearDown() {
    fixture.close()
  }

  private class RecordingTransport : WebSocketServer.ClientTransport {
    val messages = mutableListOf<String>()

    override suspend fun send(message: String) {
      messages.add(message)
    }

    override suspend fun close(reason: CloseReason) = Unit
  }

  private fun recordResults(scope: CoroutineScope): List<String> {
    ReflectionHelpers.getField<CoroutineScope>(fixture.service, "serviceScope").cancel()
    ReflectionHelpers.setField(fixture.service, "serviceScope", scope)
    val server = WebSocketServer(scope = scope)
    // Like CtrlProxyHierarchyRequestTest: mark running with an unstarted engine. No listener,
    // connection, logcat, or device is started; results go only to the in-memory transport.
    ReflectionHelpers.setField(server, "server", embeddedServer(CIO, port = 0) {})
    ReflectionHelpers.setField(fixture.service, "webSocketServer", server)
    // The original runner captured the scope which the gesture fixture cancelled at construction.
    ReflectionHelpers.setField(
      fixture.service,
      "asyncActionRunner",
      AsyncActionRunner(scope, broadcastResponse = { server.broadcast(it) }),
    )
    val transport = RecordingTransport()
    server.registerClient(1, transport)
    return transport.messages
  }

  private fun resultSince(messages: List<String>, before: Int, type: String): JsonObject {
    val result = json.parseToJsonElement(messages.drop(before).single()).jsonObject
    assertEquals(type, result["type"]?.jsonPrimitive?.content)
    return result
  }

  @Test
  fun `set text unframed and fresh requests clear caret but stale frame preserves it`() = runTest {
    val messages = recordResults(backgroundScope)
    val fresh = fixture.freshFrameContext()
    for (mode in listOf("legacy", "null", "fresh", "stale")) {
      val before = messages.size
      val caret = fixture.seedCaret()
      when (mode) {
        "legacy" ->
          fixture.actions.requestSetText(
            RequestSetText(
              requestId = null,
              text = "value",
              resourceId = null,
              dismissKeyboard = false,
            ),
          )
        "null" ->
          fixture.actions.requestSetText(
            RequestSetText(
              requestId = null,
              text = "value",
              resourceId = null,
              dismissKeyboard = false,
              frameContext = null,
            ),
          )
        "fresh" ->
          fixture.actions.requestSetText(
            RequestSetText(
              requestId = null,
              text = "value",
              resourceId = null,
              dismissKeyboard = false,
              frameContext = fresh,
            ),
          )
        else ->
          fixture.actions.requestSetText(
            RequestSetText(
              requestId = null,
              text = "value",
              resourceId = null,
              dismissKeyboard = false,
              frameContext = "$fresh:stale",
            ),
          )
      }
      if (mode == "stale") assertSame(caret, fixture.rememberedCaret())
      else assertNull(fixture.rememberedCaret())
      runCurrent()
      val result = resultSince(messages, before, "set_text_result")
      assertEquals(false, result["success"]?.jsonPrimitive?.boolean)
      assertEquals(
        if (mode == "stale")
          "Stale frame context for input/set_text; observe a fresh frame before retrying"
        else "No focused editable node found",
        result["error"]?.jsonPrimitive?.content,
      )
    }
  }

  @Test
  fun `IME action unframed and fresh requests clear caret but stale frame preserves it`() =
    runTest {
      val messages = recordResults(backgroundScope)
      val fresh = fixture.freshFrameContext()
      for (mode in listOf("legacy", "null", "fresh", "stale")) {
        val before = messages.size
        val caret = fixture.seedCaret()
        when (mode) {
          "legacy" ->
            fixture.actions.requestImeAction(RequestImeAction(requestId = null, action = "search"))
          "null" ->
            fixture.actions.requestImeAction(
              RequestImeAction(requestId = null, action = "search", frameContext = null),
            )
          "fresh" ->
            fixture.actions.requestImeAction(
              RequestImeAction(requestId = null, action = "search", frameContext = fresh),
            )
          else ->
            fixture.actions.requestImeAction(
              RequestImeAction(requestId = null, action = "search", frameContext = "$fresh:stale"),
            )
        }
        if (mode == "stale") assertSame(caret, fixture.rememberedCaret())
        else assertNull(fixture.rememberedCaret())
        runCurrent()
        val result = resultSince(messages, before, "ime_action_result")
        assertEquals(false, result["success"]?.jsonPrimitive?.boolean)
        // The rejection echoes the family name; normal execution echoes the requested IME action.
        assertEquals(
          if (mode == "stale") "ime_action" else "search",
          result["action"]?.jsonPrimitive?.content,
        )
        assertEquals(
          if (mode == "stale")
            "Stale frame context for input/ime_action; observe a fresh frame before retrying"
          else "No focused editable node found for IME action",
          result["error"]?.jsonPrimitive?.content,
        )
      }
    }

  @Test
  fun `global action unframed and fresh requests clear caret but stale frame preserves it`() =
    runTest {
      val messages = recordResults(backgroundScope)
      val fresh = fixture.freshFrameContext()
      for (mode in listOf("legacy", "null", "fresh", "stale")) {
        val before = messages.size
        val globalActionsBefore = fixture.shadow.globalActionsPerformed.size
        val caret = fixture.seedCaret()
        when (mode) {
          "legacy" ->
            fixture.actions.requestGlobalAction(
              RequestGlobalAction(requestId = null, action = "back"),
            )
          "null" ->
            fixture.actions.requestGlobalAction(
              RequestGlobalAction(requestId = null, action = "back", frameContext = null),
            )
          "fresh" ->
            fixture.actions.requestGlobalAction(
              RequestGlobalAction(requestId = null, action = "back", frameContext = fresh),
            )
          else ->
            fixture.actions.requestGlobalAction(
              RequestGlobalAction(requestId = null, action = "back", frameContext = "$fresh:stale"),
            )
        }
        if (mode == "stale") assertSame(caret, fixture.rememberedCaret())
        else assertNull(fixture.rememberedCaret())
        assertEquals(
          if (mode == "stale") emptyList<Int>()
          else listOf(AccessibilityService.GLOBAL_ACTION_BACK),
          fixture.shadow.globalActionsPerformed.drop(globalActionsBefore),
        )
        runCurrent()
        val result = resultSince(messages, before, "global_action_result")
        assertEquals(
          if (mode == "stale") "global_action" else "back",
          result["action"]?.jsonPrimitive?.content,
        )
        if (mode == "stale") {
          assertEquals(false, result["success"]?.jsonPrimitive?.boolean)
          assertEquals(
            "Stale frame context for input/global_action; observe a fresh frame before retrying",
            result["error"]?.jsonPrimitive?.content,
          )
        }
      }
    }

  @Test
  @Config(sdk = [29])
  fun `screenshot requests preserve display and default to leaving prototypes visible`() = runTest {
    val messages = recordResults(backgroundScope)
    val host = FakePrototypeHost()
    ReflectionHelpers.setField(
      fixture.service,
      "prototypeController",
      PrototypeController(
        host,
        PrototypeResultSink { _, _, _ -> error("Screenshot must not mutate prototype state") },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      ),
    )
    // API 29 returns the unsupported-capture failure before Dispatchers.IO or the platform API.
    // The real broadcast path still selects the display and enters the host's hide/restore path.
    fixture.actions.requestScreenshot(RequestScreenshot(requestId = null))
    runCurrent()
    var result = resultSince(messages, 0, "screenshot_error")
    assertEquals(0, result["displayId"]?.jsonPrimitive?.int)
    assertEquals(CtrlProxyScreenshotWire.GENERIC_ERROR, result["error"]?.jsonPrimitive?.content)
    assertTrue(host.calls.isEmpty())
    for (displayId in listOf(null, 0, 2)) {
      for (hide in listOf(null, false, true)) {
        val before = messages.size
        val hostCallsBefore = host.calls.size
        if (hide == null)
          fixture.actions.requestScreenshot(
            RequestScreenshot(requestId = null, displayId = displayId),
          )
        else
          fixture.actions.requestScreenshot(
            RequestScreenshot(requestId = null, displayId = displayId, hidePrototypes = hide),
          )
        runCurrent()
        result = resultSince(messages, before, "screenshot_error")
        assertEquals(displayId ?: 0, result["displayId"]?.jsonPrimitive?.int)
        assertEquals(
          CtrlProxyScreenshotWire.GENERIC_ERROR,
          result["error"]?.jsonPrimitive?.content,
        )
        assertEquals(
          if (hide == true) listOf("hideForCapture") else emptyList<String>(),
          host.calls.drop(hostCallsBefore),
        )
        assertFalse(host.captureHidden)
      }
    }
  }

  @Test
  fun `hierarchy request resolves defaults independently and forwards explicit limits and display`() =
    runTest {
      val options = mutableListOf<Pair<Boolean, Triple<Int, Int, Int?>>>()
      fixture.service.hierarchyController.debouncer =
        HierarchyDebouncer(
          scope = backgroundScope,
          dependencies =
            HierarchyDebouncerDependencies(
              extractHierarchy = { disableAllFiltering, snapshot ->
                options.add(
                  disableAllFiltering to
                    Triple(snapshot.maxDepth, snapshot.maxNodes, snapshot.displayId),
                )
                null
              },
            ),
        )
      fixture.actions.requestHierarchy(
        RequestHierarchy(disableAllFiltering = true, requestId = null),
      )
      assertEquals(listOf(true to Triple<Int, Int, Int?>(100, 10_000, null)), options)
      for (maxDepth in listOf(null, 0)) {
        for (maxNodes in listOf(null, 37)) {
          for (displayId in listOf(null, 2)) {
            val before = options.size
            fixture.actions.requestHierarchy(
              RequestHierarchy(
                disableAllFiltering = false,
                maxDepth = maxDepth,
                maxNodes = maxNodes,
                displayId = displayId,
                requestId = null,
              ),
            )
            assertEquals(
              listOf(false to Triple(maxDepth ?: 100, maxNodes ?: 10_000, displayId)),
              options.drop(before),
            )
          }
        }
      }
    }
}
