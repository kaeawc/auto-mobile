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

/** `inspect_prototypes` reports each runtime's `/platform` through the redaction (#16463). */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeInspectPlatformControllerTest {
  @Test
  fun `inspect reports the runtime platform state through the redaction`() = runTest {
    val reports = mutableListOf<List<PrototypeStatusEntry>>()
    val controller =
      PrototypeController(
        FakePrototypeHost(),
        object : PrototypeResultSink {
          override suspend fun send(requestId: String?, success: Boolean, error: String?) = Unit

          override suspend fun sendPrototypeStatus(
            requestId: String?,
            prototypes: List<PrototypeStatusEntry>,
            droppedEvents: Long,
          ) {
            reports += prototypes
          }
        },
        clock = { testScheduler.currentTime },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer(), 500),
        render = { mapPrototypeSpec(it).request() },
        requestScope = backgroundScope,
        platform = Platform(listOf(TestPlatformModule())),
      )
    controller.show(
      "show",
      PrototypeSpec(
        "panel",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        root = PrototypeTextNode(text = "Test"),
        requires = PrototypeRequires(platform = listOf("test")),
      ),
    )
    runCurrent()
    val data = buildJsonObject { put("count", 7) }
    controller.simulatePlatformEvent("inject", "panel", "test.tick", data)
    val state = controller.activeRuntime!!.current.platformState

    controller.inspect("inspect")
    controller.inspect("inspect-location", includeLocation = true)

    val (redacted, withLocation) = reports.map { it.single().platform }
    assertEquals(PrototypeInspectPlatformRedaction.redact(state, includeLocation = false), redacted)
    assertEquals(
      PrototypeInspectPlatformRedaction.redact(state, includeLocation = true),
      withLocation,
    )
    assertEquals(data, redacted!!["test"])
  }
}
