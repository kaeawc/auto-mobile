package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PrototypePlatformReportTest {
  @Test
  fun `shared reports round trip through the Android wire model`() {
    val cases =
      Json.parseToJsonElement(
          File(fixtureDirectory().parentFile, "prototype-platform-report/report.json").readText(),
        )
        .jsonArray
    assertTrue(cases.isNotEmpty())
    val wireJson = Json { encodeDefaults = true }
    for (case in cases) {
      val report = wireJson.decodeFromJsonElement(PrototypePlatformReport.serializer(), case)
      assertEquals(case, wireJson.encodeToJsonElement(PrototypePlatformReport.serializer(), report))
    }
  }
}
