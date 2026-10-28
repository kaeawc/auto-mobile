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

/** `links.open` module (#14238): argument handling and the result shape, with a fake opener. */
class PrototypeLinksTest {
  private class FakeOpener(var result: LinkOpenResult) : UrlOpener {
    val opened = mutableListOf<Pair<String, LinkMode>>()

    override fun open(url: String, mode: LinkMode): LinkOpenResult {
      opened += url to mode
      return result
    }
  }

  private fun call(vararg args: Pair<String, String>) =
    PlatformCall(
      "c",
      "links.open",
      JsonObject(args.associate { it.first to JsonPrimitive(it.second) }),
    )

  @Test
  fun `opened reports outcome, url, mode and handler and defaults mode to auto`() = runTest {
    val opener = FakeOpener(LinkOpenResult.Opened(LinkMode.IN_APP, false, "com.android.chrome"))
    val result = PrototypeLinksModule(opener).call(call("url" to "https://a.test"))
    assertEquals(listOf("https://a.test" to LinkMode.AUTO), opener.opened)
    assertEquals(
      PlatformCallResult.Success(
        buildJsonObject {
          put("outcome", "opened")
          put("url", "https://a.test")
          put("mode", "inApp")
          put("handler", "com.android.chrome")
        },
      ),
      result,
    )
  }

  @Test
  fun `a Custom Tabs fallback is reported as fallback in external mode`() = runTest {
    val opener = FakeOpener(LinkOpenResult.Opened(LinkMode.EXTERNAL, true, null))
    val result =
      PrototypeLinksModule(opener).call(call("url" to "https://a.test", "mode" to "inApp"))
    assertEquals(listOf("https://a.test" to LinkMode.IN_APP), opener.opened)
    val value = (result as PlatformCallResult.Success).value as JsonObject
    assertEquals(JsonPrimitive("fallback"), value["outcome"])
    assertEquals(JsonPrimitive("external"), value["mode"])
    assertTrue("handler" !in value)
  }

  @Test
  fun `the result url is cut to 2048 characters`() = runTest {
    val url = "https://a.test/" + "x".repeat(3000)
    val opener = FakeOpener(LinkOpenResult.Opened(LinkMode.EXTERNAL, false, null))
    val value =
      (PrototypeLinksModule(opener).call(call("url" to url)) as PlatformCallResult.Success).value
        as JsonObject
    assertEquals(JsonPrimitive(url.take(2048)), value["url"])
  }

  @Test
  fun `no handler fails unavailable naming the scheme`() = runTest {
    val result =
      PrototypeLinksModule(FakeOpener(LinkOpenResult.Unavailable)).call(call("url" to "tel:+1"))
    val error = (result as PlatformCallResult.Failure).error
    assertEquals(PlatformErrorCode.UNAVAILABLE, error.code)
    assertEquals("No installed app opens tel links", error.message)
  }

  @Test
  fun `missing url, unknown mode and unknown call are refused without opening`() = runTest {
    val opener = FakeOpener(LinkOpenResult.Unavailable)
    val module = PrototypeLinksModule(opener)
    assertEquals(
      PlatformErrorCode.INVALID_ARGS,
      (module.call(call()) as PlatformCallResult.Failure).error.code,
    )
    assertEquals(
      PlatformErrorCode.INVALID_ARGS,
      (module.call(call("url" to "https://a.test", "mode" to "popup"))
          as PlatformCallResult.Failure)
        .error
        .code,
    )
    assertEquals(
      PlatformErrorCode.UNSUPPORTED,
      (module.call(PlatformCall("c", "links.close", JsonObject(emptyMap())))
          as PlatformCallResult.Failure)
        .error
        .code,
    )
    assertTrue(opener.opened.isEmpty())
  }
}
