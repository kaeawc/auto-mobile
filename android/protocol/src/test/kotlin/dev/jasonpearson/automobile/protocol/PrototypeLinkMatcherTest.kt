package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory

class PrototypeLinkMatcherTest {
  private val vectors =
    Json.parseToJsonElement(
        File(fixtureDirectory(), "links/matcher-vectors.json").readText(),
      )
      .jsonObject

  private fun table(value: JsonElement): List<PrototypeLinkMatcher.Entry> =
    value.jsonArray.map { element ->
      val entry = element.jsonObject
      PrototypeLinkMatcher.Entry(
        entry.getValue("path").jsonPrimitive.content,
        entry["query"]?.jsonObject?.mapValues { it.value.jsonPrimitive.content } ?: emptyMap(),
        entry["usedCaptures"]?.jsonArray?.map { it.jsonPrimitive.content }?.toSet(),
      )
    }

  private fun canCompareNumerically(expected: JsonPrimitive, actual: JsonPrimitive): Boolean =
    !expected.isString && !actual.isString && expected.doubleOrNull != null

  // JSON has one numeric kind: compare int/number outputs numerically, without coercing strings.
  private fun assertJson(expected: JsonElement, actual: JsonElement, label: String) {
    if (expected is JsonObject && actual is JsonObject) {
      assertEquals(expected.keys, actual.keys, label)
      for (key in expected.keys) assertJson(expected.getValue(key), actual.getValue(key), label)
    } else if (
      expected is JsonPrimitive &&
        actual is JsonPrimitive &&
        canCompareNumerically(expected, actual)
    ) {
      assertEquals(expected.double, actual.doubleOrNull, label)
    } else {
      assertEquals(expected, actual, label)
    }
  }

  @TestFactory
  fun matching(): List<DynamicTest> =
    vectors.getValue("matchGroups").jsonArray.flatMap { group ->
      val entries = table(group.jsonObject.getValue("table"))
      group.jsonObject.getValue("cases").jsonArray.map { element ->
        val vector = element.jsonObject
        val url = vector.getValue("url").jsonPrimitive.content
        DynamicTest.dynamicTest("${group.jsonObject.getValue("name")}: $url") {
          val match = PrototypeLinkMatcher.match(url, entries)
          val actual =
            match?.let {
              buildJsonObject {
                put("entryIndex", it.entryIndex)
                put(
                  "captures",
                  JsonObject(it.captures.mapValues { (_, value) -> JsonPrimitive(value) }),
                )
                put("query", JsonObject(it.query))
              }
            } ?: JsonNull
          assertJson(vector.getValue("expected"), actual, url)
        }
      }
    }

  @TestFactory
  fun validation(): List<DynamicTest> =
    vectors.getValue("validationCases").jsonArray.map { element ->
      val vector = element.jsonObject
      DynamicTest.dynamicTest(vector.getValue("name").jsonPrimitive.content) {
        val errors = PrototypeLinkMatcher.validateLinkTable(table(vector.getValue("table")))
        val actual =
          JsonArray(
            errors.map { error ->
              buildJsonObject {
                put("index", error.index)
                put("code", error.code)
              }
            },
          )
        assertEquals(vector.getValue("expected"), actual)
        assertTrue(errors.all { it.message.isNotEmpty() })
      }
    }
}
