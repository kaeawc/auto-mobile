package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class PrototypeLinksTest {
  private fun resolved(url: String, mode: String?) = buildJsonObject {
    put("url", url)
    if (mode != null) put("mode", mode)
  }

  @Test
  fun `resolved inApp with a non-web scheme is refused at the mode argument`() {
    for (url in
      listOf("tel:+15551234567", "mailto:a@b.test", "sms:+1555", "geo:1,2", "maps://?q=a")) {
      assertEquals(
        PrototypeSpecError("platform.args.mode", PrototypeLinks.IN_APP_MESSAGE),
        PrototypePlatformCalls.argumentsError("links.open", resolved(url, "inApp")),
      )
    }
  }

  @Test
  fun `resolved web urls and non-inApp modes pass`() {
    assertNull(
      PrototypePlatformCalls.argumentsError("links.open", resolved("https://a.test", "inApp")),
    )
    assertNull(
      PrototypePlatformCalls.argumentsError("links.open", resolved("http://a.test", "inApp")),
    )
    for (mode in listOf("external", "auto", null)) {
      assertNull(PrototypePlatformCalls.argumentsError("links.open", resolved("tel:+1555", mode)))
    }
  }

  @Test
  fun `bound spec arguments are left to the runtime`() {
    val args = buildJsonObject {
      put("url", buildJsonObject { put("state", "url") })
      put("mode", buildJsonObject { put("value", "inApp") })
    }
    assertNull(PrototypeLinks.argumentsError(args, "root.args"))
  }
}
