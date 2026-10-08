package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/** Device-free mapping and runtime behaviour of the Material component nodes (#10439). */
class OverlayComponentsTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      OverlaySpecValidator.validate("{}")
    }
  }

  private val events = mutableListOf<OverlayEvent>()
  private var sequence = 0L

  private fun spec(root: OverlayNode, state: Map<String, OverlayScalar>) =
    OverlaySpec("panel", OverlayWindow(OverlayFullscreenPlacement()), state, root)

  private fun runtime(spec: OverlaySpec) =
    OverlayRuntime(spec, { events += it }, { 42L }, { ++sequence })

  @Test
  fun `switch checkbox and button map their role label and bound state`() {
    val state = mapOf("on" to OverlayScalar.BooleanValue(true))
    val root =
      mapOverlaySpec(
          spec(
            OverlayColumnNode(
              children =
                listOf(
                  OverlaySwitchNode(stateKey = "on", label = "Alarm"),
                  OverlayCheckboxNode(stateKey = "off"),
                  OverlayButtonNode(label = "Save", variant = "outlined"),
                )
            ),
            state + ("off" to OverlayScalar.BooleanValue(false)),
          )
        )
        .root
    val (switch, checkbox, button) = root.children
    assertEquals(listOf("switch", "checkbox", "button"), root.children.map { it.role })
    assertEquals(listOf("Alarm", "", "Save"), root.children.map { it.text })
    assertTrue(switch.checked)
    assertFalse(checkbox.checked)
    assertFalse(button.checked)
    assertEquals("checkbox", overlayContentDescription("checkbox", "", null, tappable = false))
  }

  @Test
  fun `toggle flips the bound boolean emits change then runs the node actions`() = runTest {
    val runtime =
      runtime(
        spec(
          OverlaySwitchNode(stateKey = "on"),
          mapOf("on" to OverlayScalar.BooleanValue(false)),
        )
      )
    runtime.handle(OverlayInteraction.Toggle("on", listOf(OverlayEmitAction("tapped"))))
    assertEquals(OverlayScalar.BooleanValue(true), runtime.current.state["on"])
    assertEquals(listOf("change", "tapped"), events.map { it.name })
    assertEquals(
      buildJsonObject {
        put("key", "on")
        put("value", true)
      },
      events.first().payload,
    )
    assertEquals(mapOf("on" to OverlayScalar.BooleanValue(true)), events.first().state)
    runtime.handle(OverlayInteraction.Toggle("on"))
    assertEquals(OverlayScalar.BooleanValue(false), runtime.current.state["on"])
    assertEquals(3, events.size)
  }

  @Test
  fun `a toggle on a key that is not a boolean is inert`() = runTest {
    val runtime = runtime(spec(OverlaySpacerNode(), mapOf("count" to OverlayScalar.Numeric(1.0))))
    runtime.handle(OverlayInteraction.Toggle("count", listOf(OverlayEmitAction("tapped"))))
    runtime.handle(OverlayInteraction.Toggle("missing"))
    assertEquals(OverlayScalar.Numeric(1.0), runtime.current.state["count"])
    assertTrue(events.isEmpty())
  }

  @Test
  fun `setState cannot retype a toggle binding`() = runTest {
    val runtime =
      runtime(
        spec(OverlaySwitchNode(stateKey = "on"), mapOf("on" to OverlayScalar.BooleanValue(true)))
      )
    val error = runCatching {
      runtime.handle(
        OverlayInteraction.Tap(listOf(OverlaySetStateAction("on", OverlayScalar.Text("yes"))))
      )
    }
      .exceptionOrNull()
    assertTrue("$error", error is IllegalArgumentException)
    assertEquals(OverlayScalar.BooleanValue(true), runtime.current.state["on"])
  }
}
