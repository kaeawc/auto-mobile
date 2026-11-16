package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/** Replays the shared notifications report cases (#14277) the TypeScript reference defines. */
class PrototypeNotificationsReportTest {
  private val cases =
    Json.parseToJsonElement(
        File(fixtureDirectory().parentFile, "prototype-notifications/report.json").readText(),
      )
      .jsonArray
      .map { it.jsonObject }

  @Test
  fun `the shared fixture holds cases`() {
    assertTrue(cases.isNotEmpty())
  }

  @TestFactory
  fun sharedCases(): List<DynamicTest> = cases.map { case ->
    val name = case.getValue("name").jsonPrimitive.content
    DynamicTest.dynamicTest(name) {
      assertEquals(
        case.getValue("report"),
        PrototypeNotificationsReport.of(case.getValue("snapshot")),
        name,
      )
    }
  }

  @Test
  fun `names a prototype id only for a non-empty proto tag`() {
    assertEquals("upload", PrototypeNotificationsReport.idOfTag(JsonPrimitive("proto:upload")))
    assertNull(PrototypeNotificationsReport.idOfTag(JsonPrimitive("proto:")))
    assertNull(PrototypeNotificationsReport.idOfTag(JsonPrimitive("Discovery")))
    assertNull(PrototypeNotificationsReport.idOfTag(JsonNull))
  }
}
