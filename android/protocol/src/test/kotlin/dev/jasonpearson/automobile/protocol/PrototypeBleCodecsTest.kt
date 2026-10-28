package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/** BLE codecs (#14266) replay the fixture the TypeScript reference and Swift twin replay. */
class PrototypeBleCodecsTest {
  private val fixture: JsonObject =
    Json.parseToJsonElement(File(fixtureDirectory(), "ble/codecs.json").readText()).jsonObject

  private fun bytes(hex: String) = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

  @Test
  fun `the codec list and attribute limit match the shared fixture`() {
    assertEquals(
      fixture.getValue("codecs").jsonArray.map { it.jsonPrimitive.content },
      PrototypeBleCodecs.codecs,
    )
    assertEquals(fixture.getValue("maxBytes").jsonPrimitive.int, PrototypeBleCodecs.MAX_VALUE_BYTES)
  }

  @TestFactory
  fun `shared codec fixture`(): List<DynamicTest> =
    fixture.getValue("cases").jsonArray.map { raw ->
      val case = raw.jsonObject
      DynamicTest.dynamicTest(case.getValue("name").jsonPrimitive.content) {
        val codec = case.getValue("codec").jsonPrimitive.content
        val error = case["error"]?.jsonPrimitive?.content
        val actual: Any =
          if (case.getValue("op").jsonPrimitive.content == "decode") {
            when (
              val result =
                PrototypeBleCodecs.decode(
                  codec,
                  bytes(case.getValue("input").jsonPrimitive.content),
                )
            ) {
              is PrototypeBleCodecs.Result.Ok -> result.value
              is PrototypeBleCodecs.Result.Failure -> result.error.wireValue
            }
          } else {
            when (val result = PrototypeBleCodecs.encode(codec, case.getValue("input"))) {
              is PrototypeBleCodecs.Result.Ok -> hex(result.value)
              is PrototypeBleCodecs.Result.Failure -> result.error.wireValue
            }
          }
        val expected: Any =
          error
            ?: if (case.getValue("op").jsonPrimitive.content == "decode") case.getValue("expected")
            else case.getValue("expected").jsonPrimitive.content
        assertEquals(expected, actual)
      }
    }
}
