package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityEvent
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class InteractionEventControllerTest {
  private class FakeTimer(var now: Long = 10_000L) : TimeProvider {
    override fun currentTimeMillis(): Long = now
  }

  private class FakeHost : InteractionEventController.Host {
    var connections = 1
    var generation = 1
    var running = true
    var windowClass: String? = "com.example.MainActivity"
    val frames = mutableListOf<JsonObject>()

    override fun connectionCount() = connections

    override fun observerSessionGeneration() = generation

    override fun isServerRunning() = running

    override suspend fun broadcast(message: String) {
      frames += Json.parseToJsonElement(message).jsonObject
    }

    override fun lastWindowClassName() = windowClass

    override fun launchInServiceScope(block: suspend CoroutineScope.() -> Unit) {
      runBlocking { block() }
    }
  }

  private val host = FakeHost()
  private val timer = FakeTimer()
  private val controller = InteractionEventController(host, timer, Json { encodeDefaults = true })

  private fun event(
    text: String? = null,
    scrollX: Int = 0,
    scrollY: Int = 0,
    contentChangeTypes: Int = 0,
  ): AccessibilityEvent =
    mockk(relaxed = true) {
      every { source } returns null
      every { packageName } returns "com.example"
      every { className } returns "android.widget.Button"
      every { this@mockk.text } returns
        (text?.let { mutableListOf<CharSequence>(it) } ?: mutableListOf())
      every { scrollDeltaX } returns scrollX
      every { scrollDeltaY } returns scrollY
      every { this@mockk.contentChangeTypes } returns contentChangeTypes
    }

  private fun eventOf(index: Int) = host.frames[index]["event"]!!.jsonObject

  @Test
  fun tapBroadcastsInteractionFrameWithEventFallbackElement() {
    controller.record(event(), InteractionDispatch.TAP)

    assertEquals(1, host.frames.size)
    assertEquals("interaction_event", host.frames[0]["type"]!!.jsonPrimitive.content)
    assertEquals(10_000L, host.frames[0]["timestamp"]!!.jsonPrimitive.content.toLong())
    assertEquals("tap", eventOf(0)["type"]!!.jsonPrimitive.content)
    assertEquals("com.example", eventOf(0)["packageName"]!!.jsonPrimitive.content)
    assertEquals(
      "com.example.MainActivity",
      eventOf(0)["screenClassName"]!!.jsonPrimitive.content,
    )
    assertEquals(
      "android.widget.Button",
      eventOf(0)["element"]!!.jsonObject["class"]!!.jsonPrimitive.content,
    )
  }

  @Test
  fun noConnectionsRecordsNothing() {
    host.connections = 0

    controller.record(event(), InteractionDispatch.TAP)

    assertEquals(0, host.frames.size)
  }

  @Test
  fun stoppedServerSkipsBroadcast() {
    host.running = false

    controller.record(event(), InteractionDispatch.NAVIGATE)

    assertEquals(0, host.frames.size)
  }

  @Test
  fun inputTextIsDebouncedAndCarriesText() {
    controller.record(event(text = "a"), InteractionDispatch.INPUT_TEXT)
    timer.now += 99
    controller.record(event(text = "ab"), InteractionDispatch.INPUT_TEXT)
    timer.now += 1
    controller.record(event(text = "abc"), InteractionDispatch.INPUT_TEXT)

    assertEquals(2, host.frames.size)
    assertEquals("a", eventOf(0)["text"]!!.jsonPrimitive.content)
    assertEquals("abc", eventOf(1)["text"]!!.jsonPrimitive.content)
  }

  @Test
  @Config(sdk = [30])
  fun stateChangeContentChangeIsDebouncedAndOtherContentChangesIgnored() {
    val stateChange = AccessibilityEvent.CONTENT_CHANGE_TYPE_STATE_DESCRIPTION
    controller.record(event(contentChangeTypes = 0), InteractionDispatch.CONTENT_CHANGED)
    controller.record(
      event(contentChangeTypes = stateChange),
      InteractionDispatch.CONTENT_CHANGED,
    )
    timer.now += 199
    controller.record(
      event(contentChangeTypes = stateChange),
      InteractionDispatch.CONTENT_CHANGED,
    )
    timer.now += 1
    controller.record(
      event(contentChangeTypes = stateChange),
      InteractionDispatch.CONTENT_CHANGED,
    )

    assertEquals(2, host.frames.size)
    assertEquals("stateChange", eventOf(0)["type"]!!.jsonPrimitive.content)
  }

  @Test
  fun scrollAccumulatesDeltasUntilDebounceWindowElapses() {
    timer.now = 1_000L
    controller.record(event(scrollY = 10), InteractionDispatch.SCROLL)
    timer.now += 100
    controller.record(event(scrollY = 20), InteractionDispatch.SCROLL)
    timer.now += 100
    controller.record(event(scrollY = 30), InteractionDispatch.SCROLL)

    // The first sample flushes immediately; the next two are held back inside the window.
    assertEquals(1, host.frames.size)
    assertEquals(10, eventOf(0)["scrollDeltaY"]!!.jsonPrimitive.int)

    timer.now += 100
    controller.record(event(scrollY = 40), InteractionDispatch.SCROLL)

    assertEquals(2, host.frames.size)
    assertEquals("scroll", eventOf(1)["type"]!!.jsonPrimitive.content)
    assertEquals(90, eventOf(1)["scrollDeltaY"]!!.jsonPrimitive.int)
  }

  @Test
  fun newObserverSessionDiscardsStalePendingScroll() {
    timer.now = 1_000L
    controller.record(event(scrollY = 10), InteractionDispatch.SCROLL)
    timer.now += 100
    controller.record(event(scrollY = 500), InteractionDispatch.SCROLL)
    host.generation = 2
    timer.now += 300
    controller.record(event(scrollY = 7), InteractionDispatch.SCROLL)

    assertEquals(2, host.frames.size)
    assertEquals(7, eventOf(1)["scrollDeltaY"]!!.jsonPrimitive.int)
  }

  @Test
  fun elementIsNullWhenEventCarriesNoData() {
    val bare: AccessibilityEvent =
      mockk(relaxed = true) {
        every { source } returns null
        every { packageName } returns null
        every { className } returns null
        every { contentDescription } returns null
        every { text } returns mutableListOf()
      }

    controller.record(bare, InteractionDispatch.SELECT)

    assertEquals(1, host.frames.size)
    assertEquals(JsonNull, eventOf(0)["element"])
  }
}
