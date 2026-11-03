package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/** Cast event data (#14239) replays the fixture the TypeScript reference and Swift twin replay. */
class PrototypeCastEventsTest {
  private val fixture: JsonObject =
    Json.parseToJsonElement(File(fixtureDirectory(), "cast/events.json").readText()).jsonObject

  private fun strings(key: String) =
    fixture.getValue(key).jsonArray.map { it.jsonPrimitive.content }

  @Test
  fun `the event and reason lists match the shared fixture`() {
    assertEquals(strings("events"), PrototypeCastEvents.events)
    assertEquals(strings("failureReasons"), PrototypeCastEvents.failureReasons)
  }

  @TestFactory
  fun `shared cast event fixture`(): List<DynamicTest> =
    fixture.getValue("cases").jsonArray.map { raw ->
      val case = raw.jsonObject
      DynamicTest.dynamicTest(case.getValue("name").jsonPrimitive.content) {
        val event = case.getValue("event").jsonPrimitive.content
        val data = case.getValue("data")
        val expected =
          if (case.getValue("valid").jsonPrimitive.boolean) {
            PrototypeCastEvents.Event(event.removePrefix("cast."), data.jsonObject)
          } else {
            null
          }
        assertEquals(expected, PrototypeCastEvents.decode(event, data))
      }
    }
}
