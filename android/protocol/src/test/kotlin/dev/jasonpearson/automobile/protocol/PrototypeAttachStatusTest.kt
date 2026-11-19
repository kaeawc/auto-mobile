package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test

class PrototypeAttachStatusTest {
  private val json = Json {
    encodeDefaults = true
    classDiscriminator = "type"
  }

  @Test
  fun `attach status is omitted on legacy replies and round trips when present`() {
    val legacy = PrototypeResult(0, "r", true)
    assertFalse(
      json
        .encodeToJsonElement(WebSocketResponse.serializer(), legacy)
        .jsonObject
        .containsKey("status"),
    )
    val status = buildJsonObject {
      put("shown", false)
      put("id", JsonNull)
      put("droppedEvents", 5)
    }
    val result = legacy.copy(status = status)
    val wire = json.encodeToString(WebSocketResponse.serializer(), result)
    assertEquals(status, json.parseToJsonElement(wire).jsonObject["status"])
    assertEquals(result, json.decodeFromString(WebSocketResponse.serializer(), wire))
  }
}
