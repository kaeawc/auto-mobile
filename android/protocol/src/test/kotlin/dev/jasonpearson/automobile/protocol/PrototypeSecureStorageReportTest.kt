package dev.jasonpearson.automobile.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*

class PrototypeSecureStorageReportTest {
  @Test
  fun `secure metadata encodes only key presence and bytes`() {
    val report =
      PrototypeStorageReport(
        1,
        emptyList(),
        0,
        secure = listOf(PrototypeStorageSecureMetadata("state:token", true, 12)),
      )
    val json = Json.parseToJsonElement(Json.encodeToString(report)).jsonObject
    val entry = json.getValue("secure").jsonArray.single().jsonObject
    assertEquals(setOf("key", "present", "bytes"), entry.keys)
    assertEquals(JsonPrimitive(true), entry["present"])
    assertEquals(JsonPrimitive(12), entry["bytes"])
    assertEquals(0, json.getValue("totalBytes").jsonPrimitive.int)
  }

  @Test
  fun `legacy storage reports omit the optional secure field`() {
    val json =
      Json.parseToJsonElement(Json.encodeToString(PrototypeStorageReport(1, emptyList(), 0)))
        .jsonObject
    assertFalse("secure" in json)
  }
}
