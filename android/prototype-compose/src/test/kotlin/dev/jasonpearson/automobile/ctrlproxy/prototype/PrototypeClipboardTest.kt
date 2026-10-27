package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.prototype.*
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeClipboardTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      // Initialize serializers and coroutine machinery outside the per-test timing budget.
      PrototypeClipboardTest().pasteWritesDataAndStatus()
    }
  }

  private fun call(op: String, args: JsonObject = JsonObject(emptyMap())) =
    PlatformCall("clipboard", "clipboard.$op", args)

  @Test
  fun copySensitiveAndHasText() = runTest {
    val clipboard = FakePrototypeClipboard()
    val module = PrototypeClipboardModule(clipboard)
    val result =
      module.call(
        call(
          "copy",
          buildJsonObject {
            put("text", "secret")
            put("sensitive", true)
            put("label", "Code")
          },
        ),
      )
    assertEquals(
      PlatformCallResult.Success(
        buildJsonObject {
          put("op", "copy")
          put("bytes", 6)
        },
      ),
      result,
    )
    assertEquals("secret", clipboard.text)
    assertTrue(clipboard.sensitive)
    assertEquals("Code", clipboard.label)
    assertEquals(
      listOf(
        buildJsonObject {
          put("op", "copy")
          put("bytes", 6)
        },
      ),
      clipboard.platformCalls,
    )
    assertEquals(PlatformCallResult.Success(JsonPrimitive(true)), module.call(call("hasText")))
  }

  @Test
  fun emptyAndDenied() = runTest {
    val clipboard = FakePrototypeClipboard()
    val module = PrototypeClipboardModule(clipboard)
    assertEquals(
      PlatformCallResult.Success(
        buildJsonObject {
          put("text", "")
          put("truncated", false)
        },
      ),
      module.call(call("paste")),
    )
    clipboard.denied = true
    assertEquals(
      PlatformErrorCode.PERMISSION_DENIED,
      (module.call(call("paste")) as PlatformCallResult.Failure).error.code,
    )
  }

  @Test
  fun truncatesAtUtf8ScalarBoundary() = runTest {
    val text = "a".repeat(65535)
    val clipboard = FakePrototypeClipboard(text + "🧑")
    val module = PrototypeClipboardModule(clipboard)
    assertEquals(
      PlatformCallResult.Success(
        buildJsonObject {
          put("text", text)
          put("truncated", true)
        },
      ),
      module.call(call("paste")),
    )
    clipboard.text = "é".repeat(32768)
    val result = module.call(call("paste")) as PlatformCallResult.Success
    assertEquals(JsonPrimitive(false), result.value.jsonObject["truncated"])
  }

  @Test
  fun rejectsOversizeCopy() = runTest {
    val clipboard = FakePrototypeClipboard()
    val result =
      PrototypeClipboardModule(clipboard)
        .call(call("copy", buildJsonObject { put("text", "é".repeat(32769)) }))
    assertEquals(PlatformErrorCode.INVALID_ARGS, (result as PlatformCallResult.Failure).error.code)
    assertEquals("", clipboard.text)
  }

  @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
  @Test
  fun pasteWritesDataAndStatus() = runTest {
    val spec =
      dev.jasonpearson.automobile.protocol.PrototypeSpec(
        "clipboard",
        dev.jasonpearson.automobile.protocol.PrototypeWindow(
          dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement(),
        ),
        root = dev.jasonpearson.automobile.protocol.PrototypeTextNode(text = "Clipboard"),
        state =
          mapOf("status" to dev.jasonpearson.automobile.protocol.PrototypeScalar.Text("idle")),
        data = JsonObject(emptyMap()),
        requires =
          dev.jasonpearson.automobile.protocol.PrototypeRequires(platform = listOf("clipboard")),
      )
    val events = mutableListOf<dev.jasonpearson.automobile.protocol.PrototypeEvent>()
    var sequence = 0L
    val runtime =
      PrototypeRuntime(
        spec,
        sink = { events.add(it) },
        clock = { testScheduler.currentTime },
        nextSequence = { ++sequence },
        newRequestId = { "clipboard-call" },
        requestScope = backgroundScope,
        exclusively = { it() },
        platform =
          PrototypePlatform(listOf(PrototypeClipboardModule(FakePrototypeClipboard("invite")))),
      )
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(
          dev.jasonpearson.automobile.protocol.PrototypePlatformAction(
            "clipboard.paste",
            into = "/data/code",
            statusKey = "status",
          ),
        ),
      ),
    )
    runCurrent()
    assertEquals(
      buildJsonObject {
        put("text", "invite")
        put("truncated", false)
      },
      runtime.current.spec.data?.get("code"),
    )
    assertEquals(
      dev.jasonpearson.automobile.protocol.PrototypeScalar.Text("success"),
      runtime.current.spec.state?.get("status"),
    )
    val payload = events.last().payload?.jsonObject
    assertEquals(JsonPrimitive("paste"), payload?.get("op"))
    assertEquals(JsonPrimitive(6), payload?.get("bytes"))
    assertFalse(payload.orEmpty().containsKey("text"))
    runtime.close()
  }

  @Test
  fun exceptionMessagesCannotLeakSensitiveText() = runTest {
    val clipboard =
      object : PrototypeClipboard {
        override fun copy(text: String, sensitive: Boolean, label: String?) {
          throw java.io.IOException("secret clipboard content")
        }

        override suspend fun paste(): String = throw java.io.IOException("secret clipboard content")

        override suspend fun hasText(): Boolean = false
      }
    val module = PrototypeClipboardModule(clipboard)
    val expected =
      PlatformCallResult.Failure(
        PlatformError(PlatformErrorCode.PLATFORM_ERROR, "Clipboard operation failed"),
      )
    assertEquals(
      expected,
      module.call(
        call(
          "copy",
          buildJsonObject {
            put("text", "secret")
            put("sensitive", true)
          },
        ),
      ),
    )
    assertEquals(expected, module.call(call("paste")))
  }
}
