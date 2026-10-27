package dev.jasonpearson.automobile.ctrlproxy

import android.content.ClipboardManager
import android.content.Context
import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.ErrorResponse
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ClipboardControllerTest {
  private class FakeTimer : TimeProvider {
    override fun currentTimeMillis() = 3_000L
  }

  private class FakeSender : FakeResultTransport() {
    val frames = mutableListOf<Triple<String, String?, JsonObject>>()

    override suspend fun sendFrame(frame: String) {
      val frame = Json.parseToJsonElement(frame).jsonObject
      frames +=
        Triple(
          frame.getValue("type").jsonPrimitive.content,
          frame["requestId"]?.jsonPrimitive?.content,
          JsonObject(frame - setOf("type", "timestamp", "requestId", "perfTiming")),
        )
    }
  }

  private val timer = FakeTimer()
  private val sender = FakeSender()
  private val errors = mutableListOf<ErrorResponse>()
  private val clipboard =
    RuntimeEnvironment.getApplication().getSystemService(Context.CLIPBOARD_SERVICE)
      as ClipboardManager
  private val controller =
    ClipboardController(
      clipboardManager = { clipboard },
      activeWindowRoot = { null as AccessibilityNodeInfo? },
      perfProvider = PerfProvider.createForTesting(timer),
      timeProvider = timer,
      resultSender =
        guardedResultSender(
          sender,
          ResultBroadcaster(broadcastError = { errors += it }, logError = { _, _ -> }),
        ),
    )

  private fun lastFrame(): JsonObject = sender.frames.last().third

  @Test
  fun `copy requires text`() = runTest {
    controller.performClipboard("r1", "copy", null)

    assertEquals("clipboard_result", sender.frames.single().first)
    assertEquals("r1", sender.frames.single().second)
    assertFalse(lastFrame()["success"]!!.jsonPrimitive.boolean)
    assertEquals("Text is required for copy action", lastFrame()["error"]!!.jsonPrimitive.content)
  }

  @Test
  fun `copy then get round-trips the text`() = runTest {
    controller.performClipboard("r1", "copy", "hello")
    controller.performClipboard("r2", "get", null)

    assertTrue(sender.frames[0].third["success"]!!.jsonPrimitive.boolean)
    assertEquals("hello", sender.frames[1].third["text"]!!.jsonPrimitive.content)
    assertEquals("get", sender.frames[1].third["action"]!!.jsonPrimitive.content)
    assertEquals(0L, sender.frames[1].third["totalTimeMs"]!!.jsonPrimitive.content.toLong())
  }

  @Test
  fun `clear empties the primary clip`() = runTest {
    controller.performClipboard("r1", "copy", "hello")
    controller.performClipboard("r2", "clear", null)

    assertTrue(sender.frames[1].third["success"]!!.jsonPrimitive.boolean)
    assertNull(clipboard.primaryClip?.getItemAt(0)?.text?.takeIf { it.isNotEmpty() })
  }

  @Test
  fun `paste without a focused input explains what to do`() = runTest {
    controller.performClipboard("r1", "paste", null)

    assertFalse(lastFrame()["success"]!!.jsonPrimitive.boolean)
    assertEquals(
      "No focused input field found. Focus a text field before pasting.",
      lastFrame()["error"]!!.jsonPrimitive.content,
    )
  }

  @Test
  fun `unknown actions are rejected with their name`() = runTest {
    controller.performClipboard("r1", "shred", null)

    assertEquals("Unknown action: shred", lastFrame()["error"]!!.jsonPrimitive.content)
  }

  @Test
  fun `nothing is sent while the socket server is not running`() = runTest {
    sender.running = false

    controller.performClipboard("r1", "shred", null)

    assertTrue(sender.frames.isEmpty())
  }
}
