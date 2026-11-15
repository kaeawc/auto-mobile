package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/** The location event summary (#16463) replays the fixture the TypeScript reference replays. */
class PrototypeLocationEventSummaryTest {
  private val fixture: JsonObject =
    Json.parseToJsonElement(
        File(fixtureDirectory().parentFile, "prototype-location/event-summary.json").readText()
      )
      .jsonObject

  @TestFactory
  fun `shared event summary cases`(): List<DynamicTest> =
    fixture.getValue("cases").jsonArray.map { raw ->
      val case = raw.jsonObject
      DynamicTest.dynamicTest(case.getValue("name").jsonPrimitive.content) {
        val fix = case.getValue("fix").jsonObject
        val summary = checkNotNull(PrototypeLocationEventSummary.of(fix))
        val expected = case.getValue("expected").jsonObject
        assertEquals(expected.keys, summary.keys)
        assertEquals(
          expected.getValue("accuracyM").jsonPrimitive.double,
          summary.getValue("accuracyM").jsonPrimitive.double,
        )
        assertEquals(
          expected.getValue("approximate").jsonPrimitive.boolean,
          summary.getValue("approximate").jsonPrimitive.boolean,
        )
      }
    }

  @Test
  fun `a fix without a numeric accuracy or a boolean approximate has no summary`() {
    assertNull(PrototypeLocationEventSummary.of(buildJsonObject { put("approximate", false) }))
    assertNull(
      PrototypeLocationEventSummary.of(
        buildJsonObject {
          put("accuracyM", "12")
          put("approximate", false)
        }
      )
    )
    assertNull(
      PrototypeLocationEventSummary.of(
        buildJsonObject {
          put("accuracyM", 12)
          put("approximate", JsonPrimitive("false"))
        }
      )
    )
  }
}
