package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

abstract class WebSocketRequestTestSupport {
  protected val json = Json {
    // Mirrors WebSocketServer.protocolJson, including its numeric decoding policy.
    prettyPrint = false
    ignoreUnknownKeys = true
    classDiscriminator = "type"
  }

  companion object {
    // Initialize serializer discovery outside individual protocol-test timing.
    @JvmStatic
    @BeforeAll
    fun initializeRequestSerialization() {
      val json = Json { classDiscriminator = "type" }
      val request = RequestCommitText(text = "", delivery = ImeTextDelivery.CLEAR_FIELD)
      json.decodeFromString<WebSocketRequest>(json.encodeToString<WebSocketRequest>(request))
    }
  }
}

class WebSocketRequestTest : WebSocketRequestTestSupport() {
  @Test
  fun `pin saved prototype decodes optional icon`() {
    assertEquals(
      PinSavedPrototype("pin", "panel", "icon"),
      json.decodeFromString<WebSocketRequest>(
        """{"type":"pin_saved_prototype","requestId":"pin","id":"panel","icon":"icon"}""",
      ),
    )
    assertEquals(
      PinSavedPrototype(id = "panel"),
      json.decodeFromString<WebSocketRequest>("""{"type":"pin_saved_prototype","id":"panel"}"""),
    )
  }

  @Test
  fun `saved prototype requests decode correlated and default fields`() {
    val spec =
      """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hello"}}"""
    val saved =
      assertIs<SavePrototype>(
        json.decodeFromString<WebSocketRequest>(
          """{"type":"save_prototype","requestId":"save","spec":$spec,"label":"Panel","icon":"hero"}""",
        ),
      )
    assertEquals("save", saved.requestId)
    assertEquals(json.decodeFromString<PrototypeSpec>(spec), saved.spec)
    assertEquals("Panel", saved.label)
    assertEquals("hero", saved.icon)
    val absent =
      assertIs<SavePrototype>(
        json.decodeFromString<WebSocketRequest>(
          """{"type":"save_prototype","spec":$spec,"label":"Panel"}""",
        ),
      )
    assertNull(absent.requestId)
    assertNull(absent.icon)
    assertEquals(
      ListSavedPrototypes("list"),
      json.decodeFromString<WebSocketRequest>(
        """{"type":"list_saved_prototypes","requestId":"list"}""",
      ),
    )
    assertEquals(
      ListSavedPrototypes(),
      json.decodeFromString<WebSocketRequest>(
        """{"type":"list_saved_prototypes"}""",
      ),
    )
    assertEquals(
      DeleteSavedPrototype("delete", "panel"),
      json.decodeFromString<WebSocketRequest>(
        """{"type":"delete_saved_prototype","requestId":"delete","id":"panel"}""",
      ),
    )
    assertEquals(
      DeleteSavedPrototype(id = "panel"),
      json.decodeFromString<WebSocketRequest>(
        """{"type":"delete_saved_prototype","id":"panel"}""",
      ),
    )
  }

  @Test
  fun `saved prototype requests require typed mandatory fields`() {
    for (literal in
      listOf(
        """{"type":"save_prototype","label":"Panel"}""",
        """{"type":"save_prototype","spec":{}}""",
        """{"type":"delete_saved_prototype"}""",
        """{"type":"delete_saved_prototype","id":null}""",
        """{"type":"save_prototype","spec":null,"label":"Panel"}""",
      )) {
      assertFailsWith<SerializationException> { json.decodeFromString<WebSocketRequest>(literal) }
    }
  }

  @Test
  fun `patch prototype decodes its correlated payload`() {
    val literal =
      """{"type":"patch_prototype","requestId":"r9","id":"orders","baseRevision":12,"ops":[{"op":"replace","path":"/data/cartCount","value":2}]}"""
    val request = assertIs<PatchPrototype>(json.decodeFromString<WebSocketRequest>(literal))
    assertEquals("r9", request.requestId)
    assertEquals("orders", request.id)
    assertEquals(12L, request.baseRevision)
    assertEquals(
      Json.parseToJsonElement("""[{"op":"replace","path":"/data/cartCount","value":2}]"""),
      request.ops,
    )
    val absent =
      assertIs<PatchPrototype>(
        json.decodeFromString<WebSocketRequest>(
          """{"type":"patch_prototype","id":"orders","ops":[]}""",
        ),
      )
    assertNull(absent.baseRevision)
  }

  @Test
  fun `patch prototype requires id and ops`() {
    for (literal in
      listOf(
        """{"type":"patch_prototype","ops":[]}""",
        """{"type":"patch_prototype","id":"orders"}""",
      )) {
      assertFailsWith<SerializationException> { json.decodeFromString<WebSocketRequest>(literal) }
    }
  }

  @Test
  fun `commit trace opt in round trips and omission stays false`() {
    val legacy = """{"type":"request_commit_text","text":"value"}"""
    val absent = assertIs<RequestCommitText>(json.decodeFromString<WebSocketRequest>(legacy))
    assertFalse(absent.trace)
    assertEquals(legacy, json.encodeToString<WebSocketRequest>(absent))
    val literal = """{"type":"request_commit_text","text":"value","timeoutMs":1500,"trace":true}"""
    val traced = assertIs<RequestCommitText>(json.decodeFromString<WebSocketRequest>(literal))
    assertTrue(traced.trace)
    assertEquals(literal, json.encodeToString<WebSocketRequest>(traced))
  }

  @Test
  fun `clear field delivery round trips without a text sentinel`() {
    val literal =
      """{"type":"request_commit_text","requestId":"clear-1","text":"","delivery":"clearField"}"""
    val request = assertIs<RequestCommitText>(json.decodeFromString<WebSocketRequest>(literal))
    assertEquals(ImeTextDelivery.CLEAR_FIELD, request.delivery)
    assertEquals("", request.text)
    assertEquals(literal, json.encodeToString<WebSocketRequest>(request))
    assertEquals(
      request,
      json.decodeFromString<WebSocketRequest>(json.encodeToString<WebSocketRequest>(request)),
    )
  }

  @Test
  fun `commit timeout round trips and absent or null fields preserve legacy defaults`() {
    val literal =
      """{"type":"request_commit_text","requestId":"commit-1","text":"long text","timeoutMs":14500}"""
    val request = assertIs<RequestCommitText>(json.decodeFromString<WebSocketRequest>(literal))
    assertEquals(14_500L, request.timeoutMs)
    assertEquals(literal, json.encodeToString<WebSocketRequest>(request))
    assertEquals(
      request,
      json.decodeFromString<WebSocketRequest>(json.encodeToString<WebSocketRequest>(request)),
    )
    val legacy = """{"type":"request_commit_text","requestId":"commit-1","text":"long text"}"""
    val absent = assertIs<RequestCommitText>(json.decodeFromString<WebSocketRequest>(legacy))
    assertEquals(null, absent.timeoutMs)
    assertEquals(legacy, json.encodeToString<WebSocketRequest>(absent))
    val explicitNull = legacy.dropLast(1) + """, "timeoutMs":null}"""
    assertEquals(absent, json.decodeFromString<WebSocketRequest>(explicitNull))
    // Request decoding must retain tolerance for future additive host fields.
    val future = literal.dropLast(1) + """, "futureBudget":true}"""
    assertEquals(request, json.decodeFromString<WebSocketRequest>(future))
    // Older APKs use the same unknown-key tolerance with a schema lacking timeoutMs.
    val older = json.decodeFromString<LegacyCommitText>(literal)
    assertEquals("long text", older.text)
    assertEquals("commit-1", older.requestId)
  }

  @Serializable private data class LegacyCommitText(val requestId: String? = null, val text: String)

  @Test
  fun `decimal millisecond literals are rejected rather than truncated or rounded`() {
    val coordinates = "\"x1\":1,\"y1\":2,\"x2\":3,\"y2\":4"
    val cases =
      listOf(
        Triple("request_tap_coordinates", "\"x\":1,\"y\":2", "duration"),
        Triple("request_swipe", coordinates, "duration"),
        Triple("request_two_finger_swipe", coordinates, "duration"),
        Triple("request_drag", coordinates, "pressDurationMs"),
        Triple("request_drag", coordinates, "dragDurationMs"),
        Triple("request_drag", coordinates, "holdDurationMs"),
        Triple("request_drag", coordinates, "holdTime"),
        Triple("request_drag", coordinates, "duration"),
        Triple(
          "request_pinch",
          "\"centerX\":1,\"centerY\":2,\"distanceStart\":3,\"distanceEnd\":4",
          "duration",
        ),
        Triple("set_hierarchy_interval", "", "intervalMs"),
        Triple("request_commit_text", "\"text\":\"x\"", "timeoutMs"),
        // Millisecond timestamps also use Long, but are not gesture durations.
        Triple("request_hierarchy_if_stale", "", "sinceTimestamp"),
        Triple("set_network_error_simulation", "\"enabled\":false", "expiresAtEpochMs"),
        Triple("set_network_error_simulation", "\"enabled\":false", "remainingMs"),
      )
    for ((type, requiredFields, field) in cases) {
      val prefix = if (requiredFields.isEmpty()) "" else "$requiredFields,"
      // A whole-valued decimal (250.0) still has a decimal point in the JSON token.
      for (literal in listOf("250.5", "250.0")) {
        val payload = """{"type":"$type","requestId":"ms-pin",$prefix"$field":$literal}"""
        val failure =
          assertFailsWith<SerializationException>("$type.$field = $literal") {
            json.decodeFromString<WebSocketRequest>(payload)
          }
        assertTrue(failure.message.orEmpty().contains(literal), "$type.$field = $literal")
      }
      // Control: each payload really is otherwise valid and reaches its concrete request class.
      val integerPayload = """{"type":"$type","requestId":"ms-pin",$prefix"$field":250}"""
      val request = json.decodeFromString<WebSocketRequest>(integerPayload)
      assertEquals("ms-pin", request.requestId)
      assertEquals(
        request,
        json.decodeFromString<WebSocketRequest>(json.encodeToString(request)),
      )
    }
  }

  @Test
  fun `gesture display ids decode with absent null and explicit values and round trip`() {
    val payloads =
      listOf(
        "request_tap_coordinates" to "\"x\":1,\"y\":2",
        "request_swipe" to "\"x1\":1,\"y1\":2,\"x2\":3,\"y2\":4",
        "request_two_finger_swipe" to "\"x1\":1,\"y1\":2,\"x2\":3,\"y2\":4",
        "request_drag" to "\"x1\":1,\"y1\":2,\"x2\":3,\"y2\":4",
        "request_pinch" to "\"centerX\":1,\"centerY\":2,\"distanceStart\":3,\"distanceEnd\":4",
        "request_gesture_start" to "\"gestureId\":\"g\",\"x\":1,\"y\":2",
      )
    for ((type, fields) in payloads) {
      for ((suffix, expected) in
        listOf("" to null, ",\"displayId\":null" to null, ",\"displayId\":7" to 7)) {
        val request = json.decodeFromString<WebSocketRequest>("{\"type\":\"$type\",$fields$suffix}")
        val displayId =
          when (request) {
            is RequestTapCoordinates -> request.displayId
            is RequestSwipe -> request.displayId
            is RequestTwoFingerSwipe -> request.displayId
            is RequestDrag -> request.displayId
            is RequestPinch -> request.displayId
            is RequestGestureStart -> request.displayId
            else -> error("Unexpected gesture request $type")
          }
        assertEquals(expected, displayId, type)
        assertEquals(request, json.decodeFromString<WebSocketRequest>(json.encodeToString(request)))
      }
    }
  }

  @Test
  fun `deserialize request_hierarchy`() {
    val message = """{"type":"request_hierarchy","requestId":"test-1"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestHierarchy>(request)
    assertEquals("test-1", request.requestId)
    assertEquals(false, request.disableAllFiltering)
  }
}
