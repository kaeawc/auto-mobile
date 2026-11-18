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
  fun `overlay refuses a permissions spec before opening its window`() = runTest {
    var result: Boolean? = null
    val host = FakePrototypeHost()
    val controller =
      PrototypeController(
        host,
        PrototypeResultSink { _, success, _ -> result = success },
        clock = { testScheduler.currentTime },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
        requestScope = backgroundScope,
        render = { mapPrototypeSpec(it).request() },
      )
    controller.show(
      "show",
      PrototypeSpec(
        "permissions",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        requires = PrototypeRequires(platform = listOf("permissions")),
        root = PrototypeButtonNode(label = "Allow"),
      ),
    )
    assertEquals(false, result)
    assertNull(controller.activeRuntime)
    assertTrue(host.calls.isEmpty())
  }

  @Test
  fun `ComponentActivity registry includes Activity modules while overlay omits them`() {
    val controller =
      org.robolectric.Robolectric.buildActivity(androidx.activity.ComponentActivity::class.java)
        .setup()
    val platform = prototypeRuntimePlatform(controller.get())
    assertTrue(PrototypeBiometricModule.CAPABILITY in platform.registry.capabilities)
    assertTrue(PrototypePermissionsModule.CAPABILITY in platform.registry.capabilities)
    assertTrue(PrototypeSecureStorageModule.CAPABILITY in platform.registry.capabilities)
    assertFalse("prototype_platform_notifications_v1" in platform.registry.capabilities)
    assertFalse(
      PrototypeBiometricModule.CAPABILITY in
        prototypeRuntimePlatform(android.content.ContextWrapper(null)).registry.capabilities,
    )
    assertFalse(
      PrototypePermissionsModule.CAPABILITY in
        prototypeRuntimePlatform(android.content.ContextWrapper(null)).registry.capabilities,
    )
    closePrototypeModules(platform)
    controller.pause().stop().destroy()
  }

  @Test
  fun `overlay refuses a biometric spec before opening its window`() = runTest {
    var result: Boolean? = null
    val host = FakePrototypeHost()
    val controller =
      PrototypeController(
        host,
        PrototypeResultSink { _, success, _ -> result = success },
        clock = { testScheduler.currentTime },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
        requestScope = backgroundScope,
        render = { mapPrototypeSpec(it).request() },
      )
    val spec =
      PrototypeSpec(
        "biometric",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        requires = PrototypeRequires(platform = listOf("biometric")),
        root = PrototypeButtonNode(label = "Unlock"),
      )
    controller.show("show", spec)
    assertEquals(false, result)
    assertNull(controller.activeRuntime)
    assertTrue(host.calls.isEmpty())
  }

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
