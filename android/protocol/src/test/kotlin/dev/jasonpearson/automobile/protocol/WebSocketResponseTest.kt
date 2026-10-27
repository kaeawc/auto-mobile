package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Test

abstract class WebSocketResponseTestSupport {
  protected val json = Json {
    classDiscriminator = "type"
    encodeDefaults = true
  }
}

class WebSocketResponseTest : WebSocketResponseTestSupport() {
  @Test
  fun `patch request round trips alongside revision bearing replies`() {
    val literal =
      """{"type":"patch_prototype","requestId":"patch","id":"panel","baseRevision":7,"ops":[{"op":"replace","path":"/state/query","value":"typed"}]}"""
    val request = assertIs<PatchPrototype>(json.decodeFromString<WebSocketRequest>(literal))
    assertEquals(7L, request.baseRevision)
    assertEquals(
      request,
      json.decodeFromString<WebSocketRequest>(json.encodeToString<WebSocketRequest>(request)),
    )
  }

  @Test
  fun `prototype patch result omits unset fields and encodes bare conflict scalars`() {
    val legacy = PrototypeResult(42L, "r", true)
    val encoded = json.encodeToString<WebSocketResponse>(legacy)
    assertFalse(encoded.contains("revision"))
    assertFalse(encoded.contains("conflict"))
    val state =
      mapOf(
        "text" to PrototypeScalar.Text("typed"),
        "number" to PrototypeScalar.Numeric(7.0),
        "flag" to PrototypeScalar.BooleanValue(true),
      )
    val conflict =
      legacy.copy(
        success = false,
        error = "conflict",
        revision = 9L,
        conflict = PrototypePatchConflict(9L, state),
      )
    val wire = json.encodeToString<WebSocketResponse>(conflict)
    val parsed = json.parseToJsonElement(wire) as kotlinx.serialization.json.JsonObject
    assertEquals(kotlinx.serialization.json.JsonPrimitive(9L), parsed["revision"])
    val expected =
      json.parseToJsonElement(
        """{"revision":9,"state":{"text":"typed","number":7.0,"flag":true}}""",
      )
    assertEquals(expected, parsed["conflict"])
    assertEquals(conflict, json.decodeFromString<WebSocketResponse>(wire))
    val success = legacy.copy(revision = 10L)
    val successWire = json.encodeToString<WebSocketResponse>(success)
    assertFalse(successWire.contains("conflict"))
    assertEquals(success, json.decodeFromString<WebSocketResponse>(successWire))
  }

  @Test
  fun `IME action approximation is optional and round trips when present`() {
    val exact = ImeActionResult(timestamp = 1L, success = true, action = "next", totalTimeMs = 0L)
    val encoded = json.encodeToString(ImeActionResult.serializer(), exact)
    assertFalse(encoded.contains("approximated"))
    assertNull(json.decodeFromString(ImeActionResult.serializer(), encoded).approximated)
    for (success in listOf(true, false)) {
      val fallback = exact.copy(success = success, approximated = true)
      assertEquals(
        fallback,
        json.decodeFromString(
          ImeActionResult.serializer(),
          json.encodeToString(ImeActionResult.serializer(), fallback),
        ),
      )
    }
  }

  @Test
  fun `traversal truncation metadata is optional and omitted when null`() {
    val complete = TraversalOrderData(elements = emptyList(), focusedIndex = null, totalCount = 0)
    val encoded = json.encodeToString(TraversalOrderData.serializer(), complete)
    assertFalse(encoded.contains("truncationReasons"))
    assertNull(json.decodeFromString(TraversalOrderData.serializer(), encoded).truncationReasons)

    val truncated = complete.copy(truncationReasons = listOf("max_children"))
    assertEquals(
      truncated,
      json.decodeFromString(
        TraversalOrderData.serializer(),
        json.encodeToString(TraversalOrderData.serializer(), truncated),
      ),
    )
  }

  @Test
  fun `action result already-satisfied flag defaults to false and round-trips`() {
    val plain = ActionResult(timestamp = 1L, success = true, action = "click", totalTimeMs = 2L)
    assertFalse(plain.alreadySatisfied)

    val satisfied = plain.copy(action = "focus", alreadySatisfied = true)
    val decoded =
      json.decodeFromString(
        ActionResult.serializer(),
        json.encodeToString(ActionResult.serializer(), satisfied),
      )
    assertTrue(decoded.alreadySatisfied)

    // An older runner omits the field entirely.
    val legacy =
      json.decodeFromString(
        ActionResult.serializer(),
        """{"timestamp":1,"success":true,"action":"focus","totalTimeMs":2}""",
      )
    assertFalse(legacy.alreadySatisfied)
  }

  @Test
  fun `serialize crash and ANR timestamps on the envelope`() {
    val deviceInfo = DeviceInfo("Pixel 7", "Google", "14", 34)
    val crash: WebSocketResponse =
      CrashEvent(
        timestamp = 1700000000000L,
        event =
          CrashData(
            exceptionClass = "java.lang.NullPointerException",
            message = null,
            stackTrace = "at com.example.Main.run(Main.java:42)",
            threadName = "main",
            packageName = "com.example.app",
            deviceInfo = deviceInfo,
          ),
      )
    val anr: WebSocketResponse =
      AnrEvent(
        timestamp = 1700000000500L,
        event =
          AnrData(
            pid = 12345,
            processName = "com.example.app",
            importance = "FOREGROUND",
            trace = null,
            reason = "Input dispatching timed out",
            packageName = "com.example.app",
            deviceInfo = deviceInfo,
          ),
      )

    assertEquals(
      """{"type":"crash_event","timestamp":1700000000000,"event":{"exceptionClass":"java.lang.NullPointerException","message":null,"stackTrace":"at com.example.Main.run(Main.java:42)","threadName":"main","currentScreen":null,"packageName":"com.example.app","appVersion":null,"deviceInfo":{"model":"Pixel 7","manufacturer":"Google","osVersion":"14","sdkInt":34},"applicationId":null}}""",
      json.encodeToString(WebSocketResponse.serializer(), crash),
    )
    assertEquals(
      """{"type":"anr_event","timestamp":1700000000500,"event":{"pid":12345,"processName":"com.example.app","importance":"FOREGROUND","trace":null,"reason":"Input dispatching timed out","packageName":"com.example.app","appVersion":null,"deviceInfo":{"model":"Pixel 7","manufacturer":"Google","osVersion":"14","sdkInt":34}}}""",
      json.encodeToString(WebSocketResponse.serializer(), anr),
    )
  }

  @Test
  fun `serialize handled exception message under the message key`() {
    val handled: WebSocketResponse =
      HandledExceptionEvent(
        timestamp = 1700000001000L,
        event =
          HandledExceptionData(
            exceptionClass = "java.lang.IllegalStateException",
            message = "cart is empty",
            stackTrace = "at com.example.Main.run(Main.java:42)",
            packageName = "com.example.app",
            deviceInfo = DeviceInfo("Pixel 7", "Google", "14", 34),
          ),
      )

    assertEquals(
      """{"type":"handled_exception_event","timestamp":1700000001000,"event":{"exceptionClass":"java.lang.IllegalStateException","message":"cart is empty","stackTrace":"at com.example.Main.run(Main.java:42)","customMessage":null,"currentScreen":null,"packageName":"com.example.app","appVersion":null,"deviceInfo":{"model":"Pixel 7","manufacturer":"Google","osVersion":"14","sdkInt":34},"applicationId":null}}""",
      json.encodeToString(WebSocketResponse.serializer(), handled),
    )
  }

  @Test
  fun `serialize swipe_result`() {
    val response: WebSocketResponse =
      SwipeResult(
        timestamp = 1234567890L,
        requestId = "swipe-1",
        success = true,
        totalTimeMs = 350L,
        gestureTimeMs = 300L,
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"swipe_result""""))
    assertTrue(encoded.contains(""""requestId":"swipe-1""""))
    assertTrue(encoded.contains(""""success":true"""))
    assertTrue(encoded.contains(""""totalTimeMs":350"""))
    assertTrue(encoded.contains(""""gestureTimeMs":300"""))
  }

  @Test
  fun `serialize screenshot_result`() {
    val response: WebSocketResponse =
      ScreenshotResult(
        timestamp = 1234567890L,
        requestId = "ss-1",
        data = "base64data",
        format = "png",
        width = 1080,
        height = 1920,
        rotation = 1,
        screenshotCaptureDurationMs = 42L,
        screenshotEncodeDurationMs = 7L,
        screenshotByteLength = 1200,
        screenshotBase64Length = 1600,
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue("\"rotation\":1" in encoded)

    assertTrue(encoded.contains(""""type":"screenshot""""))
    assertTrue(encoded.contains(""""requestId":"ss-1""""))
    assertTrue(encoded.contains(""""data":"base64data""""))
    assertTrue(encoded.contains(""""format":"png""""))
    assertTrue(encoded.contains(""""width":1080"""))
    assertTrue(encoded.contains(""""height":1920"""))
    assertTrue(encoded.contains(""""screenshotCaptureDurationMs":42"""))
    assertTrue(encoded.contains(""""screenshotEncodeDurationMs":7"""))
    assertTrue(encoded.contains(""""screenshotByteLength":1200"""))
    assertTrue(encoded.contains(""""screenshotBase64Length":1600"""))
  }

  @Test
  fun `serialize hierarchy_update event`() {
    val response: WebSocketResponse =
      HierarchyUpdateEvent(
        timestamp = 1234567890L,
        data = """{"nodes":[]}""",
        perfTiming = """{"total":50}""",
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"hierarchy_update""""))
    // The service embeds both as JSON objects, not quoted strings (#11877).
    assertTrue(encoded.contains(""""data":{"nodes":[]}"""), encoded)
    assertTrue(encoded.contains(""""perfTiming":{"total":50}"""), encoded)
    val decoded = json.decodeFromString(WebSocketResponse.serializer(), encoded)
    assertEquals(response, decoded)
    assertTrue(encoded.contains("\"requestId\":null"), encoded)
  }

  @Test
  fun `serialize correlated hierarchy_update event`() {
    val response: WebSocketResponse =
      HierarchyUpdateEvent(timestamp = 123L, data = "{}", requestId = "req-1")

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""requestId":"req-1""""))
  }
}
