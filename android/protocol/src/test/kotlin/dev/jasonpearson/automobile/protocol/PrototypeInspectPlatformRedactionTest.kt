package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory

/**
 * The inspect `/platform` redaction (#16463) replays the fixture the TypeScript reference replays.
 */
class PrototypeInspectPlatformRedactionTest {
  private val fixture: JsonObject =
    Json.parseToJsonElement(
        File(fixtureDirectory().parentFile, "prototype-location/inspect-redaction.json").readText(),
      )
      .jsonObject

  @TestFactory
  fun `shared inspect redaction cases`(): List<DynamicTest> {
    val cases = fixture.getValue("cases").jsonArray
    assertFalse(cases.isEmpty())
    return cases.map { raw ->
      val case = raw.jsonObject
      DynamicTest.dynamicTest(case.getValue("name").jsonPrimitive.content) {
        assertEquals(
          case.getValue("expected"),
          PrototypeInspectPlatformRedaction.redact(
            case.getValue("platform").jsonObject,
            includeLocation = case.getValue("includeLocation").jsonPrimitive.boolean,
          ),
        )
      }
    }
  }
}
