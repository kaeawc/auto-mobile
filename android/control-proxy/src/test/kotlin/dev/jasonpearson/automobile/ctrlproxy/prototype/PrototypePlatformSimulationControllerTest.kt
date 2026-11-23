package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.PrototypePlatform as Platform
import dev.jasonpearson.automobile.prototype.TestPlatformModule
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypePlatformSimulationControllerTest {
  @Test
  fun `host injection reports correlated success and failures for the shown id`() = runTest {
    val replies = mutableListOf<Triple<String?, Boolean, String?>>()
    val events = mutableListOf<PrototypeEvent>()
    val module = TestPlatformModule()
    val controller =
      PrototypeController(
        FakePrototypeHost(),
        object : PrototypeResultSink {
          override suspend fun send(requestId: String?, success: Boolean, error: String?) {
            replies += Triple(requestId, success, error)
          }
        },
        eventSink = PrototypeEventSink { events += it },
        clock = { testScheduler.currentTime },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer(), 500),
        render = { mapPrototypeSpec(it).request() },
        requestScope = backgroundScope,
        platform = Platform(listOf(module)),
      )
    val spec =
      PrototypeSpec(
        "panel",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        root = PrototypeTextNode(text = "Test"),
        requires = PrototypeRequires(platform = listOf("test")),
      )
    controller.show("show", spec)
    runCurrent()
    val data = buildJsonObject { put("count", 7) }
    controller.simulatePlatformEvent("inject", "panel", "test.tick", data)
    assertEquals(Triple("inject", true, null), replies.last())
    assertEquals(data, controller.activeRuntime!!.current.platformState["test"])
    assertEquals(
      JsonPrimitive(true),
      events
        .single { it.name == PrototypePlatform.DELIVERED_EVENT_NAME }
        .payload!!
        .jsonObject["simulated"],
    )
    controller.simulatePlatformEvent("missing", "missing", "test.tick", data)
    assertEquals("missing", replies.last().first)
    assertFalse(replies.last().second)
    assertTrue(replies.last().third!!.contains("Unknown prototype"))
    controller.simulatePlatformEvent("unknown", "panel", "test.unknown", data)
    assertEquals("unknown", replies.last().first)
    assertFalse(replies.last().second)
    assertTrue(replies.last().third!!.contains("Unknown platform event"))
    assertEquals(1, events.count { it.name == PrototypePlatform.DELIVERED_EVENT_NAME })
    val outcome = buildJsonObject { put("result", JsonNull) }
    controller.queueCallOutcome("script", "panel", "test.echo", outcome)
    assertEquals(Triple("script", true, null), replies.last())
    controller.queueCallOutcome("wrong", "other", "test.echo", outcome)
    assertEquals("wrong", replies.last().first)
    assertFalse(replies.last().second)
    assertTrue(replies.last().third!!.contains("inactive"))
    controller.queueCallOutcome("unknown-call", "panel", "test.unknown", outcome)
    assertFalse(replies.last().second)
    assertTrue(replies.last().third!!.contains("Unknown platform call"))
    controller.dismiss("dismiss", "panel", false)
    controller.queueCallOutcome("dismissed", "panel", "test.echo", outcome)
    assertFalse(replies.last().second)
    assertTrue(replies.last().third!!.contains("inactive"))
  }
}
