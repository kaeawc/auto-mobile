package dev.jasonpearson.automobile.desktop.core.telemetry

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class TelemetryDeviceAttributionTest {
  private val categories =
    listOf(
      "network",
      "log",
      "custom",
      "os",
      "navigation",
      "crash",
      "storage",
      "layout",
      "toolcall",
      "accessibility",
      "memory",
      "performance",
    )

  @Test
  fun `every parsed category carries the envelope's device and device epoch`() {
    categories.forEach { category ->
      val event =
        parseTelemetryEvent(
          TelemetryEventEnvelope(
            category = category,
            timestamp = 7L,
            deviceId = "emulator-5554",
            deviceSessionUuid = "uuid-a",
            data = JsonObject(mapOf("message" to JsonPrimitive("m"))),
          ),
        )
      requireNotNull(event) { "category $category did not parse" }
      assertEquals(category, "emulator-5554", event.deviceId)
      assertEquals(category, "uuid-a", event.deviceSessionUuid)
    }
  }

  @Test
  fun `wire envelope decodes deviceSessionUuid`() {
    val envelope =
      telemetryJson.decodeFromString(
        TelemetryEventEnvelope.serializer(),
        """{"category":"log","timestamp":1,"deviceId":"d","deviceSessionUuid":"u","sessionId":"s","data":{}}""",
      )
    assertEquals("u", envelope.deviceSessionUuid)
    assertEquals("u", parseTelemetryEvent(envelope)?.deviceSessionUuid)
  }
}
