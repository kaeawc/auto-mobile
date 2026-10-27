package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

@OptIn(ExperimentalSerializationApi::class)
class PrototypeStatusEntryTimerTest {
  private val json = Json {
    encodeDefaults = true
    classDiscriminator = "type"
  }

  @Test
  fun emptyTimersAreOmittedEvenWhenDefaultsAreEncoded() {
    val status = PrototypeStatusEntry("panel", false, emptyMap(), lastSequence = 0)
    assertFalse("timers" in json.encodeToJsonElement(status).jsonObject)
    val report = PrototypeTimerReport("a", 150, 2)
    val encoded = json.encodeToJsonElement(status.copy(timers = listOf(report)))
    assertEquals(report, json.decodeFromJsonElement<PrototypeStatusEntry>(encoded).timers.single())
  }

  @Test
  fun shaderFallbackReasonsAreOptionalAndRoundTrip() {
    val status = PrototypeStatusEntry("panel", false, emptyMap(), lastSequence = 0)
    assertFalse("shaderFailures" in json.encodeToJsonElement(status).jsonObject)
    val failures = mapOf("root/node" to "Shader draw failed: invalid effect")
    val encoded = json.encodeToJsonElement(status.copy(shaderFailures = failures))
    assertEquals(failures, json.decodeFromJsonElement<PrototypeStatusEntry>(encoded).shaderFailures)
  }

  @Test
  fun clockAdvanceAndFiredResultUseExpectedWireNames() {
    val request =
      json
        .encodeToJsonElement<WebSocketRequest>(AdvancePrototypeClock("r", "panel", 250))
        .jsonObject
    assertEquals("advance_prototype_clock", request.getValue("type").jsonPrimitive.content)
    assertEquals(250, request.getValue("advanceTimeMs").jsonPrimitive.int)
    val result =
      json
        .encodeToJsonElement<WebSocketResponse>(PrototypeResult(0, "r", true, fired = 2))
        .jsonObject
    assertEquals("prototype_result", result.getValue("type").jsonPrimitive.content)
    assertEquals(2, result.getValue("fired").jsonPrimitive.int)
  }
}
