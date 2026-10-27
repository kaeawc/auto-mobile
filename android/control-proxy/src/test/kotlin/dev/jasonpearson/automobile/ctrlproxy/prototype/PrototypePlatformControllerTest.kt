package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.PrototypePlatform as Platform
import dev.jasonpearson.automobile.prototype.TestPlatformModule
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypePlatformControllerTest {
  @Test
  fun `dismiss replacement and reset cancel calls before the old surface closes`() = runTest {
    for (mode in listOf("dismiss", "replace", "reset")) {
      val events = mutableListOf<PrototypeEvent>()
      var cancelled = 0
      val module = TestPlatformModule {
        try {
          awaitCancellation()
        } finally {
          cancelled++
        }
      }
      val controller =
        PrototypeController(
          FakePrototypeHost(),
          PrototypeResultSink { _, success, error -> check(success) { error.orEmpty() } },
          eventSink = { events += it },
          clock = { testScheduler.currentTime },
          lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
          requestScope = backgroundScope,
          platform = Platform(listOf(module)),
          render = { mapPrototypeSpec(it).request() },
        )
      val call =
        PrototypePlatformAction(
          "test.echo",
          mapOf("message" to buildJsonObject { put("value", "hello") }),
          into = "/data/result",
          statusKey = "status",
        )
      val spec =
        PrototypeSpec(
          "platform",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          state = mapOf("status" to PrototypeScalar.Text("idle")),
          data = buildJsonObject { put("result", "old") },
          requires = PrototypeRequires(platform = listOf("test")),
          root = PrototypeButtonNode(label = "echo", onTap = listOf(call)),
        )
      controller.show("show", spec)
      val old = checkNotNull(controller.activeRuntime)
      controller.interact(old, PrototypeInteraction.Tap(listOf(call)))
      runCurrent()
      if (mode == "dismiss") controller.dismiss("dismiss", spec.id, false)
      else controller.show("replace", spec, reset = mode == "reset")
      runCurrent()
      assertFalse(old.current.active)
      assertEquals(1, cancelled)
      val event = events.single { it.name == PrototypePlatform.CALL_EVENT_NAME }
      assertEquals(
        "cancelled",
        event.payload!!.jsonObject["error"]!!.jsonObject["code"]!!.jsonPrimitive.content,
      )
      assertEquals(JsonPrimitive("old"), old.current.spec.data!!["result"])
      if (mode == "dismiss") assertEquals(PrototypeEventKind.DISMISSED, events.last().kind)
      else controller.dismiss("cleanup", spec.id, false)
    }
  }
}
