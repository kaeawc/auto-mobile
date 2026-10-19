package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TestPlanValidatorClockTest {
  @Test
  fun `unquoted clock instant reports window error instead of Date pattern error`() {
    val result =
      TestPlanValidator.validateYaml(
        """
        name: clock-plan
        steps:
          - tool: setDeviceState
            clock:
              mode: set
              instant: 1999-01-01T00:00:00Z
        """
          .trimIndent(),
      )
    assertFalse(result.valid)
    assertEquals(1, result.errors.size, result.errors.toString())
    assertEquals("steps[0].clock.instant", result.errors.single().field)
    assertTrue(result.errors.single().message.contains("2000-01-01"), result.errors.toString())
  }

  @Test
  fun `clock instant window normalizes offsets in inline and params forms`() {
    val cases =
      listOf(
        "1900-01-01T00:00:00Z" to false,
        "2200-01-01T00:00:00Z" to false,
        "2000-01-01T00:00:00+01:00" to false,
        "1999-12-31T23:00:00-01:00" to true,
        "2000-01-01T00:00:00Z" to true,
        "2100-01-01T00:00:00Z" to true,
        "2100-01-01T00:00:01Z" to false,
        "2099-12-31T23:59:59-01:00" to false,
        "2100-01-01T01:00:00+01:00" to true,
        "2100-01-01T00:00:00.0001Z" to false,
        "2100-01-01T01:00:00.0001+01:00" to false,
        "1999-12-31T23:00:00.0001-01:00" to true,
      )
    for (params in listOf(false, true)) {
      for ((instant, valid) in cases) {
        val clock = "\"clock\":{\"mode\":\"set\",\"instant\":\"$instant\"}"
        val fields = if (params) "\"params\":{$clock}" else clock
        val result =
          TestPlanValidator.validateYaml(
            "{\"name\":\"clock-window\",\"steps\":[{\"tool\":\"setDeviceState\",$fields}]}",
          )
        assertEquals(valid, result.valid, "$instant params=$params")
        if (!valid) {
          val field = if (params) "steps[0].params.clock.instant" else "steps[0].clock.instant"
          assertTrue(result.errors.any { it.field == field && it.message.contains("2000-01-01") })
        }
      }
    }
  }

  @Test
  fun `clock instant window accepts arbitrary fractional precision`() {
    val cases =
      listOf(
        "2030-01-01T00:00:00.1234567890Z" to true,
        "2100-01-01T00:00:00.0000000000Z" to true,
        "2100-01-01T00:00:00.0000000000001Z" to false,
        "2000-01-01T00:00:00.0000000000001Z" to true,
        "1999-12-31T23:59:59.9999999999Z" to false,
      )
    for (params in listOf(false, true)) {
      for ((instant, valid) in cases) {
        val clock = "\"clock\":{\"mode\":\"set\",\"instant\":\"$instant\"}"
        val fields = if (params) "\"params\":{$clock}" else clock
        val result =
          TestPlanValidator.validateYaml(
            "{\"name\":\"clock-fraction\",\"steps\":[{\"tool\":\"setDeviceState\",$fields}]}",
          )
        assertEquals(valid, result.valid, "$instant params=$params")
        if (!valid) {
          val field = if (params) "steps[0].params.clock.instant" else "steps[0].clock.instant"
          assertTrue(
            result.errors.any {
              it.field == field &&
                it.message ==
                  "Clock instant must be within 2000-01-01T00:00:00Z .. 2100-01-01T00:00:00Z (inclusive, after offset normalization)." &&
                it.severity == ValidationSeverity.ERROR
            },
          )
        }
      }
    }
  }

  @Test
  fun `clock window uses params override in both directions`() {
    val cases =
      listOf(
        Triple("1900-01-01T00:00:00Z", "2030-01-01T00:00:00Z", true),
        Triple("2030-01-01T00:00:00Z", "2200-01-01T00:00:00Z", false),
      )
    for ((inline, params, valid) in cases) {
      val yaml =
        """
        name: clock-override-window
        steps:
          - tool: setDeviceState
            clock:
              mode: set
              instant: "$inline"
            params:
              clock:
                mode: set
                instant: "$params"
        """
          .trimIndent()
      val result = TestPlanValidator.validateYaml(yaml)
      assertEquals(valid, result.valid)
    }
  }
}
