package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.prototype.fixtureFile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class PrototypeDeviceStatusMappingTest {
  private fun replay(file: String, key: String, map: (List<JsonElement>) -> Any?) {
    val fixture =
      Json.parseToJsonElement(
          fixtureFile("prototype-device-status/mapping-$file.json").readText(),
        )
        .jsonObject
    for (row in fixture.getValue(key).jsonArray) {
      val cells = row.jsonArray
      val actual =
        when (val value = map(cells)) {
          null -> JsonNull
          is String -> JsonPrimitive(value)
          is Int -> JsonPrimitive(value)
          else -> error("Unexpected mapping result $value")
        }
      assertEquals("$file/$key: $row", cells.last(), actual)
    }
  }

  @Test
  fun `battery mappings replay Android fixture verbatim`() {
    replay("battery", "androidState") {
      PrototypeDeviceStatus.batteryState(it[0].jsonPrimitive.int)
    }
    replay("battery", "androidLevel") {
      PrototypeDeviceStatus.percent(it[0].jsonPrimitive.double, it[1].jsonPrimitive.double)
    }
    assertFalse(PrototypeDeviceStatus.battery(-1, 100, 1).containsKey("level"))
    assertFalse(PrototypeDeviceStatus.battery(5, 0, 1).containsKey("level"))
  }

  @Test
  fun `thermal mappings replay Android fixture including fractional status`() {
    replay("thermal", "android") { PrototypeDeviceStatus.thermal(it[0].jsonPrimitive.double) }
    assertFalse(PrototypeDeviceStatus.power(false, null).containsKey("thermal"))
  }

  @Test
  fun `audio mappings replay Android fixture verbatim`() {
    replay("audio", "androidVolume") {
      PrototypeDeviceStatus.percent(it[0].jsonPrimitive.double, it[1].jsonPrimitive.double)
    }
    replay("audio", "androidRinger") { PrototypeDeviceStatus.ringer(it[0].jsonPrimitive.int) }
  }

  @Test
  fun `audio mute and route priority are deterministic`() {
    assertEquals("other", PrototypeDeviceStatus.audioRoute(emptySet()))
    assertEquals(
      "bluetooth",
      PrototypeDeviceStatus.audioRoute(setOf("speaker", "wired", "usb", "bluetooth")),
    )
    assertEquals("wired", PrototypeDeviceStatus.audioRoute(setOf("speaker", "wired", "usb")))
    assertEquals("usb", PrototypeDeviceStatus.audioRoute(setOf("speaker", "usb")))
    for ((volume, mute) in listOf(0 to false, 7 to true, 7 to false)) {
      val state =
        PrototypeDeviceStatus.audio(AudioStatusReading(volume, 15, mute, setOf("speaker"), 2))
      assertEquals(JsonPrimitive(volume == 0 || mute), state["muted"])
      assertEquals(JsonPrimitive("speaker"), state["route"])
    }
  }
}
