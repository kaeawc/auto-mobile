package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** `settings.open` module (#14320): argument handling and the result shape, with a fake opener. */
class PrototypeSettingsTest {
  private class FakeOpener(var result: SettingsOpenResult) : SettingsOpener {
    val opened = mutableListOf<SettingsPage>()

    override fun open(page: SettingsPage): SettingsOpenResult {
      opened += page
      return result
    }
  }

  private fun call(name: String = "settings.open", page: JsonPrimitive? = JsonPrimitive("app")) =
    PlatformCall("c", name, JsonObject(listOfNotNull(page?.let { "page" to it }).toMap()))

  @Test
  fun `every contract page parses and reaches the opener`() = runTest {
    val opener = FakeOpener(SettingsOpenResult.Opened(false, "com.android.settings"))
    val module = PrototypeSettingsModule(opener)
    val pages = listOf("app", "notifications", "location", "wifi", "bluetooth", "display")
    for (page in pages) {
      val result = module.call(call(page = JsonPrimitive(page)))
      assertEquals(
        PlatformCallResult.Success(
          buildJsonObject {
            put("outcome", "opened")
            put("page", page)
            put("handler", "com.android.settings")
          },
        ),
        result,
      )
    }
    assertEquals(SettingsPage.entries.toList(), opener.opened)
  }

  @Test
  fun `a broader page is reported as fallback and a missing handler is omitted`() = runTest {
    val opener = FakeOpener(SettingsOpenResult.Opened(true, null))
    val result = PrototypeSettingsModule(opener).call(call(page = JsonPrimitive("notifications")))
    val value = (result as PlatformCallResult.Success).value as JsonObject
    assertEquals(JsonPrimitive("fallback"), value["outcome"])
    assertEquals(JsonPrimitive("notifications"), value["page"])
    assertTrue("handler" !in value)
  }

  @Test
  fun `no settings app is unavailable`() = runTest {
    val result =
      PrototypeSettingsModule(FakeOpener(SettingsOpenResult.Unavailable))
        .call(call(page = JsonPrimitive("wifi")))
    val failure = result as PlatformCallResult.Failure
    assertEquals(PlatformErrorCode.UNAVAILABLE, failure.error.code)
    assertTrue(failure.error.message.contains("wifi"))
  }

  @Test
  fun `an unknown, missing or non-string page is refused without opening anything`() = runTest {
    val opener = FakeOpener(SettingsOpenResult.Opened(false, null))
    val module = PrototypeSettingsModule(opener)
    for (page in listOf(JsonPrimitive("security"), null, JsonPrimitive(1))) {
      val failure = module.call(call(page = page)) as PlatformCallResult.Failure
      assertEquals(PlatformErrorCode.INVALID_ARGS, failure.error.code)
    }
    assertTrue(opener.opened.isEmpty())
  }

  @Test
  fun `another call name is unsupported`() = runTest {
    val opener = FakeOpener(SettingsOpenResult.Opened(false, null))
    val failure =
      PrototypeSettingsModule(opener).call(call(name = "settings.write"))
        as PlatformCallResult.Failure
    assertEquals(PlatformErrorCode.UNSUPPORTED, failure.error.code)
    assertTrue(opener.opened.isEmpty())
  }

  @Test
  fun `the module advertises the settings capability and is always ready`() {
    val module = PrototypeSettingsModule { SettingsOpenResult.Unavailable }
    assertEquals("settings", module.name)
    assertEquals("prototype_platform_settings_v1", module.capability)
    assertEquals(
      dev.jasonpearson.automobile.prototype.PlatformAvailability.Ready,
      module.availability(),
    )
  }
}
