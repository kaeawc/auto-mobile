package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ScreenshotWireMessageTest {
  @Test
  fun `screenshot message includes performance metadata`() {
    val message =
      buildScreenshotMessageJson(
        requestId = "screenshot-1",
        timestampMs = 1234567890L,
        screenshot =
          ScreenshotCapturePayload(
            base64Image = "jpeg-base64",
            captureDurationMs = 42L,
            encodeDurationMs = 7L,
            byteLength = 1200,
            base64Length = 1600,
          ),
      )

    val json = Json.parseToJsonElement(message).jsonObject

    assertEquals("screenshot", json.getValue("type").jsonPrimitive.content)
    assertEquals("1234567890", json.getValue("timestamp").jsonPrimitive.content)
    assertEquals("screenshot-1", json.getValue("requestId").jsonPrimitive.content)
    assertEquals("jpeg", json.getValue("format").jsonPrimitive.content)
    assertEquals("jpeg-base64", json.getValue("data").jsonPrimitive.content)
    assertEquals("42", json.getValue("screenshotCaptureDurationMs").jsonPrimitive.content)
    assertEquals("7", json.getValue("screenshotEncodeDurationMs").jsonPrimitive.content)
    assertEquals("1200", json.getValue("screenshotByteLength").jsonPrimitive.content)
    assertEquals("1600", json.getValue("screenshotBase64Length").jsonPrimitive.content)
  }

  @Test
  fun `screenshot message omits request id when absent`() {
    val message =
      buildScreenshotMessageJson(
        requestId = null,
        timestampMs = 1234567890L,
        screenshot =
          ScreenshotCapturePayload(
            base64Image = "jpeg-base64",
            captureDurationMs = 42L,
            encodeDurationMs = 7L,
            byteLength = 1200,
            base64Length = 1600,
          ),
      )

    val json = Json.parseToJsonElement(message).jsonObject

    assertFalse(json.containsKey("requestId"))
  }
}
