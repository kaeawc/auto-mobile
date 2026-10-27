package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory

/** Replays the shared realtime vectors the TypeScript suite also pins. */
class PrototypeChannelPureTest {
  private fun vectors(name: String): JsonObject =
    Json.parseToJsonElement(File(fixtureDirectory(), "realtime/$name").readText()).jsonObject

  @TestFactory
  fun `reconnect backoff vectors`(): List<DynamicTest> =
    vectors("backoff.json").getValue("cases").jsonArray.map { case ->
      val vector = case.jsonObject
      DynamicTest.dynamicTest(vector.getValue("name").jsonPrimitive.content) {
        val reconnect = vector.getValue("reconnect").jsonObject
        val randoms =
          vector.getValue("randoms").jsonArray.map { it.jsonPrimitive.content.toDouble() }
        var next = 0
        val random = { randoms[next++ % randoms.size] }
        for (expected in vector.getValue("expected").jsonArray) {
          val row = expected.jsonObject
          val delay = row.getValue("delayMs")
          assertEquals(
            if (delay is JsonNull) null else delay.jsonPrimitive.int,
            PrototypeChannelBackoff.delayMs(
              row.getValue("attempt").jsonPrimitive.int,
              reconnect["maxAttempts"]?.jsonPrimitive?.intOrNull,
              reconnect["initialDelayMs"]?.jsonPrimitive?.intOrNull,
              reconnect["maxDelayMs"]?.jsonPrimitive?.intOrNull,
              random,
            ),
            "attempt ${row.getValue("attempt")}",
          )
        }
      }
    }

  @TestFactory
  fun `frame coalescing vectors`(): List<DynamicTest> =
    vectors("coalesce.json").getValue("cases").jsonArray.map { case ->
      val vector = case.jsonObject
      DynamicTest.dynamicTest(vector.getValue("name").jsonPrimitive.content) {
        val frames = vector.getValue("frames").jsonArray.map { it.jsonArray }
        val expected: List<JsonArray> = vector.getValue("expected").jsonArray.map { it.jsonArray }
        assertEquals(expected, PrototypeChannelCoalescer.coalesce(frames))
      }
    }
}
