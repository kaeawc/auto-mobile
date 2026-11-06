package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.ctrlproxy.models.WindowInfo
import dev.jasonpearson.automobile.ctrlproxy.prototypeStatusFrame
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeWindowControlsControllerTest {
  private val scope = TestScope()
  private val hosts = mutableListOf(FakePrototypeHost())
  private val statuses = mutableListOf<List<PrototypeStatusEntry>>()
  private val results = mutableListOf<Pair<Boolean, String?>>()
  private val controller =
    PrototypeController(
      hosts.first(),
      object : PrototypeResultSink {
        override suspend fun send(requestId: String?, success: Boolean, error: String?) {
          results += success to error
        }

        override suspend fun sendPrototypeStatus(
          requestId: String?,
          prototypes: List<PrototypeStatusEntry>,
          droppedEvents: Long,
        ) {
          statuses += prototypes
        }
      },
      lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      requestScope = scope,
      hostFactory = { FakePrototypeHost().also { hosts += it } },
    )

  private fun spec(
    window: PrototypeWindow = PrototypeWindow(PrototypeFullscreenPlacement()),
    id: String = "panel",
  ) = PrototypeSpec(id, window, root = PrototypeTextNode(text = "screen"))

  @Test
  fun `controller maps every control and replaces omitted controls with defaults`() = runTest {
    val window =
      PrototypeWindow(
        PrototypeFullscreenPlacement(),
        keepScreenOn = true,
        brightness = JsonPrimitive(75),
        orientation = "portrait",
        statusBar = "dark",
      )
    controller.show(null, spec(window))
    assertTrue(results.last().toString(), results.last().first)
    assertEquals(
      PrototypeWindowControls(true, 0.75f, "portrait", "dark"),
      hosts.first().requests.last().windowControls,
    )
    controller.show(null, spec())
    assertTrue(results.last().toString(), results.last().first)
    assertEquals(PrototypeWindowControls(), hosts.first().requests.last().windowControls)
    val base = PrototypeWindow(PrototypeFullscreenPlacement())
    assertEquals(0f, base.copy(brightness = JsonPrimitive(0)).controls().brightness, 0f)
    assertEquals(1f, base.copy(brightness = JsonPrimitive(100)).controls().brightness, 0f)
    assertEquals(-1f, base.copy(brightness = JsonPrimitive("system")).controls().brightness, 0f)
  }

  @Test
  fun `inspect and window metadata report requested orientation and unsupported status bar additively`() =
    runTest {
      for ((orientation, style) in
        listOf("portrait" to "dark", "landscape" to "light", "unlocked" to "auto")) {
        controller.show(
          null,
          spec(
            PrototypeWindow(
              PrototypeFullscreenPlacement(),
              orientation = orientation,
              statusBar = style,
            ),
          ),
        )
        assertTrue(results.last().toString(), results.last().first)
        controller.inspect(null)
        val status = statuses.last().single()
        assertEquals(orientation, status.orientation)
        assertEquals("unsupported", status.statusBar)
        val metadata = checkNotNull(controller.windowMetadata("panel"))
        assertEquals(orientation, metadata.orientation)
        assertEquals("unsupported", metadata.statusBar)
        assertEquals("fullscreen", metadata.placement)
        val entry =
          Json.parseToJsonElement(prototypeStatusFrame(null, listOf(status), 0))
            .jsonObject
            .getValue("prototypes")
            .jsonArray
            .single()
            .jsonObject
        assertEquals(JsonPrimitive(orientation), entry["orientation"])
        assertEquals(JsonPrimitive("unsupported"), entry["statusBar"])
        assertEquals(JsonPrimitive(false), entry["persistent"])
        assertTrue(entry.getValue("state") is JsonObject)
      }
      controller.show(null, spec())
      controller.inspect(null)
      val status = statuses.last().single()
      assertNull(status.orientation)
      assertNull(status.statusBar)
      val frame = prototypeStatusFrame(null, listOf(status), 0)
      assertFalse(frame.contains("orientation"))
      assertFalse(frame.contains("statusBar"))
      assertNull(controller.windowMetadata("panel")?.orientation)
      assertNull(controller.windowMetadata("panel")?.statusBar)
    }

  @Test
  fun `hideKeyboard action reaches its own surface host and stops after dismissal`() = runTest {
    controller.show(null, spec(id = "first"))
    val first = checkNotNull(controller.activeRuntime)
    controller.show(null, spec(id = "second"), replaceOthers = false)
    val second = checkNotNull(controller.activeRuntime)
    assertEquals(2, hosts.size)
    controller.interact(first, PrototypeInteraction.Tap(listOf(PrototypeHideKeyboardAction)))
    assertEquals(1, hosts[0].calls.count { it == "hideKeyboard" })
    assertFalse("hideKeyboard" in hosts[1].calls)
    controller.interact(second, PrototypeInteraction.Tap(listOf(PrototypeHideKeyboardAction)))
    assertEquals(1, hosts[1].calls.count { it == "hideKeyboard" })
    controller.interact(
      first,
      PrototypeInteraction.Tap(listOf(PrototypeDismissAction, PrototypeHideKeyboardAction)),
    )
    assertEquals(1, hosts[0].calls.count { it == "hideKeyboard" })
  }

  @Test
  fun `hierarchy window control fields are additive nullable strings`() {
    val wire = Json { encodeDefaults = true }
    val original = WindowInfo(id = 4, prototypePlacement = "fullscreen", prototypeOpaque = false)
    val encoded = wire.encodeToString(WindowInfo.serializer(), original)
    assertFalse(encoded.contains("prototypeOrientation"))
    assertFalse(encoded.contains("prototypeStatusBar"))
    val controls =
      original.copy(prototypeOrientation = "portrait", prototypeStatusBar = "unsupported")
    val withControls = wire.encodeToString(WindowInfo.serializer(), controls)
    assertEquals(controls, wire.decodeFromString(WindowInfo.serializer(), withControls))
    assertEquals(original, wire.decodeFromString(WindowInfo.serializer(), encoded))
    val fields = Json.parseToJsonElement(withControls).jsonObject
    assertEquals(JsonPrimitive("portrait"), fields["prototypeOrientation"])
    assertEquals(JsonPrimitive("unsupported"), fields["prototypeStatusBar"])
    assertEquals(JsonPrimitive("fullscreen"), fields["prototypePlacement"])
    assertEquals(JsonPrimitive(false), fields["prototypeOpaque"])
  }

  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      runTest {}
      PrototypeSpecValidator.validate("{}")
      mapPrototypeSpec(
        PrototypeSpec(
          "warm",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          root = PrototypeSpacerNode(),
        ),
      )
    }
  }
}
