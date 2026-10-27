package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory

class PrototypeShareTest {
  companion object {
    private lateinit var fixtures: JsonArray

    @JvmStatic
    @BeforeAll
    fun load() {
      fixtures =
        Json.parseToJsonElement(
            File(fixtureDirectory().parentFile, "prototype-share.json").readText(),
          )
          .jsonArray
      // Contract loading and JVM class initialization belong outside per-case timing.
      PrototypeShare.resolvePrototypeShare(
        buildJsonObject { putJsonObject("text") { put("value", "warm") } },
        buildJsonObject { putJsonObject("assets") {} },
      )
    }
  }

  @TestFactory
  fun sharedResolver(): List<DynamicTest> = fixtures.map { raw ->
    val fixture = raw.jsonObject
    DynamicTest.dynamicTest(fixture.getValue("name").jsonPrimitive.content) {
      assertEquals(
        fixture["expected"],
        PrototypeShare.resolvePrototypeShare(
            fixture.getValue("args").jsonObject,
            fixture.getValue("inputs").jsonObject,
          )
          .toJson(),
      )
    }
  }
}
