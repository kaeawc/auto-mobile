package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.prototype.FakePrototypeScreenShapeSource
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.PrototypeAppearance
import dev.jasonpearson.automobile.protocol.PrototypeAppearanceMode
import dev.jasonpearson.automobile.protocol.PrototypeAppearanceSource
import dev.jasonpearson.automobile.protocol.PrototypeHiddenReason
import dev.jasonpearson.automobile.protocol.PrototypeResult
import dev.jasonpearson.automobile.protocol.PrototypeStackSnapshot
import dev.jasonpearson.automobile.protocol.SavedPrototypeEntry
import dev.jasonpearson.automobile.protocol.SavedPrototypeErrorCode
import dev.jasonpearson.automobile.protocol.SavedPrototypeInfo
import dev.jasonpearson.automobile.protocol.SavedPrototypePinInfo
import dev.jasonpearson.automobile.protocol.SavedPrototypePinStatus
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class PrototypeResultBroadcasterTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmRuntime() = runTest {
      // Exclude one-time coroutine and polymorphic codec class loading from test timings.
      val appearance =
        PrototypeAppearance(PrototypeAppearanceMode.DARK, PrototypeAppearanceSource.OVERRIDE, true)
      val frame =
        prototypeResultFrame("warmup", true, null, appearance = appearance, screenRound = false)
      Json.decodeFromString<WebSocketResponse>(frame)
    }
  }

  private val json = Json { classDiscriminator = "type" }

  private class FakeTransport : PrototypeResultTransport {
    var running = true
    var failure: Exception? = null
    val frames = mutableListOf<String>()

    override fun isRunning() = running

    override suspend fun broadcastFrame(buildFrame: () -> String) {
      failure?.let { throw it }
      frames += buildFrame()
    }
  }

  private val transport = FakeTransport()
  private val errors = mutableListOf<ErrorResponse>()
  private val shape = FakePrototypeScreenShapeSource()
  private val sink =
    PrototypeResultBroadcaster(
      transport,
      ResultBroadcaster(broadcastError = { errors += it }, logError = { _, _ -> }),
      shape,
    )

  private fun lastResult(): PrototypeResult =
    json.decodeFromString<WebSocketResponse>(transport.frames.last()) as PrototypeResult

  private val appearance =
    PrototypeAppearance(PrototypeAppearanceMode.DARK, PrototypeAppearanceSource.OVERRIDE, true)

  @Test
  fun `send is a success or failure result with no missing assets`() = runTest {
    sink.send("r1", false, "boom")

    val result = lastResult()
    assertEquals("r1", result.requestId)
    assertEquals(false, result.success)
    assertEquals("boom", result.error)
    assertNull(result.missingAssets)
  }

  @Test
  fun `missing assets ride the same result`() = runTest {
    sink.sendWithMissingAssets("r1", true, null, listOf("a", "b"))

    assertEquals(listOf("a", "b"), lastResult().missingAssets)
  }

  @Test
  fun `shown carries appearance and hidden reason`() = runTest {
    sink.sendShown("r1", listOf("a"), appearance, PrototypeHiddenReason.DEVICE_BLOCKED)

    val result = lastResult()
    assertEquals(appearance, result.appearance)
    assertEquals(PrototypeHiddenReason.DEVICE_BLOCKED, result.hiddenReason)
    assertEquals(listOf("a"), result.missingAssets)
    assertTrue(result.success)
  }

  @Test
  fun `shown navigation carries pages and stacks`() = runTest {
    val stacks = mapOf("s" to PrototypeStackSnapshot(listOf("home", "detail")))
    sink.sendShownNavigation("r1", emptyList(), appearance, mapOf("p" to 2), stacks, null)

    val result = lastResult()
    assertEquals(mapOf("p" to 2), result.pages)
    assertEquals(stacks, result.stacks)
    assertNull(result.hiddenReason)
  }

  @Test
  fun `all show variants emit known true and false shapes`() = runTest {
    for (round in listOf(true, false)) {
      shape.shapes[0] = round
      sink.sendShown("show", emptyList(), appearance, null)
      sink.sendShownNavigation("navigation", emptyList(), appearance, emptyMap(), emptyMap(), null)
      sink.sendShownDegraded(
        "degraded",
        emptyList(),
        appearance,
        emptyMap(),
        emptyMap(),
        null,
        emptyList(),
      )
      for (frame in transport.frames.takeLast(3)) {
        assertEquals(JsonPrimitive(round), json.parseToJsonElement(frame).jsonObject["screenRound"])
        assertEquals(
          round,
          (json.decodeFromString<WebSocketResponse>(frame) as PrototypeResult).screenRound,
        )
      }
    }
  }

  @Test
  fun `unknown shape is absent on the wire`() = runTest {
    sink.sendShown("show", emptyList(), appearance, null)
    sink.sendShownNavigation("navigation", emptyList(), appearance, emptyMap(), emptyMap(), null)
    sink.sendShownDegraded(
      "degraded",
      emptyList(),
      appearance,
      emptyMap(),
      emptyMap(),
      null,
      emptyList(),
    )
    for (frame in transport.frames) {
      assertFalse("screenRound" in json.parseToJsonElement(frame).jsonObject)
      assertNull((json.decodeFromString<WebSocketResponse>(frame) as PrototypeResult).screenRound)
    }
  }

  @Test
  fun `shape belongs to the actual routed display and is consumed per request`() = runTest {
    shape.shapes[0] = false
    shape.shapes[7] = true
    sink.noteShownDisplay("routed", 7)
    sink.sendShown("routed", emptyList(), appearance, null)
    assertEquals(true, lastResult().screenRound)
    sink.sendShown("default", emptyList(), appearance, null)
    assertEquals(false, lastResult().screenRound)
    sink.noteShownDisplay("unknown", 8)
    sink.sendShown("unknown", emptyList(), appearance, null)
    assertNull(lastResult().screenRound)
    assertEquals(listOf(7, 0, 8), shape.reads)
  }

  @Test
  fun `a skipped show consumes its display without reading shape`() = runTest {
    transport.running = false
    shape.shapes[0] = false
    shape.shapes[7] = true
    sink.noteShownDisplay("reused", 7)
    sink.sendShown("reused", emptyList(), appearance, null)
    assertTrue(shape.reads.isEmpty())
    transport.running = true
    sink.sendShown("reused", emptyList(), appearance, null)
    assertEquals(false, lastResult().screenRound)
  }

  @Test
  fun `non show results neither query nor emit shape`() = runTest {
    shape.shapes[0] = true
    sink.send("dismiss", true, null)
    sink.sendPatched("patch", true, null, 1, null)
    for (frame in transport.frames) {
      assertFalse("screenRound" in json.parseToJsonElement(frame).jsonObject)
    }
    assertTrue(shape.reads.isEmpty())
  }

  @Test
  fun `patched carries revision and failure`() = runTest {
    sink.sendPatched("r1", false, "stale", 7L, null)

    val result = lastResult()
    assertEquals(7L, result.revision)
    assertEquals("stale", result.error)
    assertEquals(false, result.success)
  }

  @Test
  fun `saved prototype results each carry their payload`() = runTest {
    val saved = SavedPrototypeInfo("id", "slug", false)
    sink.sendSaved("r1", saved)
    assertEquals(saved, lastResult().saved)

    val pin = SavedPrototypePinInfo("id", SavedPrototypePinStatus.REQUESTED)
    sink.sendPinned("r2", pin)
    assertEquals(pin, lastResult().pin)

    val entries = listOf(SavedPrototypeEntry("id", "Label", "slug", 5L, true))
    sink.sendSavedList("r3", entries)
    assertEquals(entries, lastResult().savedPrototypes)

    sink.sendCleared("r4", 3)
    assertEquals(3, lastResult().cleared)
  }

  @Test
  fun `refusal carries its error code`() = runTest {
    sink.sendRefusal("r1", SavedPrototypeErrorCode.entries.first(), "nope")

    val result = lastResult()
    assertEquals(SavedPrototypeErrorCode.entries.first(), result.errorCode)
    assertEquals(false, result.success)
    assertEquals("nope", result.error)
  }

  @Test
  fun `status carries dropped events`() = runTest {
    sink.sendPrototypeStatus("r1", emptyList(), 4L)

    assertEquals(4L, lastResult().droppedEvents)
  }

  @Test
  fun `nothing is sent while the socket is down`() = runTest {
    transport.running = false

    sink.send("r1", true, null)
    sink.sendCleared("r2", 1)

    assertTrue(transport.frames.isEmpty())
    assertTrue(errors.isEmpty())
  }

  @Test
  fun `a throw while sending becomes a correlated error`() = runTest {
    transport.failure = IllegalStateException("socket closed")

    sink.send("r9", true, null)

    assertEquals("r9", errors.single().requestId)
    assertTrue(errors.single().error.contains("prototype_result"))
  }
}
