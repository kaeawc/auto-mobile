package dev.jasonpearson.automobile.protocol

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class PrototypeTimerRulesTest {
  private fun validate(action: String) =
    PrototypeSpecValidator.validate(
      """{"id":"timers","window":{"placement":{"type":"fullscreen"}},"root":{"type":"button","label":"Go","onTap":[$action]}}""",
    )

  @Test
  fun acceptsTimer() {
    assertTrue(
      validate("""{"type":"startTimer","id":"a","afterMs":100,"actions":[{"type":"dismiss"}]}""")
        is PrototypeSpecValidation.Success,
    )
  }

  @Test
  fun rejectsEmptyId() {
    val result = validate("""{"type":"cancelTimer","id":""}""") as PrototypeSpecValidation.Failure
    assertEquals("root.onTap[0].id", result.error.path)
  }

  @Test
  fun maxRunsRequiresPeriod() {
    val result =
      validate(
        """{"type":"startTimer","id":"a","afterMs":100,"maxRuns":2,"actions":[{"type":"dismiss"}]}""",
      )
        as PrototypeSpecValidation.Failure
    assertEquals("root.onTap[0].maxRuns", result.error.path)
  }

  private fun start(id: String) =
    """{"type":"startTimer","id":"$id","afterMs":100,"actions":[{"type":"emit","name":"tick"}]}"""

  @Test
  fun ninthDistinctStartIsRejectedButDuplicateIdsAreAllowed() {
    val actions = (0..8).joinToString(",") { start("$it") }
    val result = validate(actions) as PrototypeSpecValidation.Failure
    assertEquals("root.onTap[8].id", result.error.path)
    assertEquals("Too many distinct timer ids", result.error.message)
    assertTrue(
      validate((0..8).joinToString(",") { start("same") }) is PrototypeSpecValidation.Success,
    )
  }

  @Test
  fun timerChildrenAreValidatedAndUnknownCancelsAreAccepted() {
    assertTrue(
      validate("""{"type":"cancelTimer","id":"unknown"}""") is PrototypeSpecValidation.Success,
    )
    val nested =
      """{"type":"startTimer","id":"outer","afterMs":100,"actions":[{"type":"startTimer","id":"inner","afterMs":100,"maxRuns":2,"actions":[{"type":"dismiss"}]}]}"""
    val result = validate(nested) as PrototypeSpecValidation.Failure
    assertEquals("root.onTap[0].actions[0].maxRuns", result.error.path)
  }

  @Test
  fun capabilityScanFindsTimerInPlatformHandlerWithoutScanningOpaquePayloads() {
    val json = kotlinx.serialization.json.Json
    val raw =
      json.parseToJsonElement(
        """{"platform":{"on":{"test.tick":[${start("handler")}]}} ,"root":{"type":"button","label":"Go","onTap":[{"type":"emit","name":"literal","payload":{"type":"cancelTimer","id":"opaque"}}]}}""",
      ) as kotlinx.serialization.json.JsonObject
    assertTrue("prototype_timers_v1" in PrototypeStrictPolicy.required(raw))
    val opaque =
      json.parseToJsonElement(
        """{"root":{"type":"button","label":"Go","onTap":[{"type":"emit","name":"literal","payload":{"type":"startTimer"}}]}}""",
      ) as kotlinx.serialization.json.JsonObject
    assertFalse("prototype_timers_v1" in PrototypeStrictPolicy.required(opaque))
  }
}
