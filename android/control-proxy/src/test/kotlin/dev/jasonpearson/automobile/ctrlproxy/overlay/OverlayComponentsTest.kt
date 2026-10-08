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

  @Test
  fun `slider chip and card map their role label bound value and children`() {
    val state =
      mapOf(
        "volume" to OverlayScalar.Numeric(7.0),
        "mon" to OverlayScalar.BooleanValue(true),
      )
    val root =
      mapOverlaySpec(
          spec(
            OverlayColumnNode(
              children =
                listOf(
                  OverlaySliderNode(stateKey = "volume", label = "Volume", min = 0.0, max = 10.0),
                  OverlayChipNode(label = "Mon", stateKey = "mon"),
                  OverlayChipNode(label = "Add"),
                  OverlayCardNode(
                    variant = "elevated",
                    children = listOf(OverlayButtonNode(label = "Save")),
                  ),
                )
            ),
            state,
          )
        )
        .root
    val (slider, filter, assist, card) = root.children
    assertEquals(listOf("slider", "chip", "chip", "card"), root.children.map { it.role })
    assertEquals(listOf("Volume", "Mon", "Add", ""), root.children.map { it.text })
    assertEquals(7.0, slider.sliderValue, 0.0)
    assertTrue(filter.checked)
    assertFalse(assist.checked)
    assertEquals(listOf("button"), card.children.map { it.role })
    assertEquals("root.children[3].children[0]", card.children.single().identity)
    assertNull(overlayContentDescription("card", "", null, tappable = false))
  }

  @Test
  fun `a card counts toward the node limit through its children`() {
    val deep =
      OverlayCardNode(
        children = List(OverlaySpecValidator.MAX_OVERLAY_NODES) { OverlaySpacerNode() }
      )
    val error = runCatching { mapOverlaySpec(spec(deep, emptyMap())) }.exceptionOrNull()
    assertTrue("$error", error is IllegalArgumentException)
  }

  @Test
  fun `slide stores the number emits change then runs the node actions`() = runTest {
    val runtime =
      runtime(
        spec(
          OverlaySliderNode(stateKey = "v", min = 0.0, max = 10.0),
          mapOf("v" to OverlayScalar.Numeric(2.0)),
        )
      )
    runtime.handle(OverlayInteraction.Slide("v", 5.0, listOf(OverlayEmitAction("moved"))))
    assertEquals(OverlayScalar.Numeric(5.0), runtime.current.state["v"])
    assertEquals(listOf("change", "moved"), events.map { it.name })
    assertEquals(
      buildJsonObject {
        put("key", "v")
        put("value", 5.0)
      },
      events.first().payload,
    )
    runtime.handle(OverlayInteraction.Slide("v", 5.0, listOf(OverlayEmitAction("moved"))))
    assertEquals(2, events.size)
  }

  @Test
  fun `slide on a key that is not a number is inert and out of range values are rejected`() =
    runTest {
      val runtime =
        runtime(
          spec(
            OverlaySliderNode(stateKey = "v", min = 0.0, max = 10.0),
            mapOf("v" to OverlayScalar.Numeric(2.0), "flag" to OverlayScalar.BooleanValue(true)),
          )
        )
      runtime.handle(OverlayInteraction.Slide("flag", 3.0))
      runtime.handle(OverlayInteraction.Slide("missing", 3.0))
      assertTrue(events.isEmpty())
      val error = runCatching {
        runtime.handle(OverlayInteraction.Slide("v", 11.0))
      }
        .exceptionOrNull()
      assertTrue("$error", error is IllegalArgumentException)
      assertEquals(OverlayScalar.Numeric(2.0), runtime.current.state["v"])
    }

  @Test
  fun `a filter chip toggles through the shared toggle interaction`() = runTest {
    val runtime =
      runtime(
        spec(
          OverlayChipNode(label = "Mon", stateKey = "mon"),
          mapOf("mon" to OverlayScalar.BooleanValue(false)),
        )
      )
    runtime.handle(OverlayInteraction.Toggle("mon"))
    assertEquals(OverlayScalar.BooleanValue(true), runtime.current.state["mon"])
    assertEquals(listOf("change"), events.map { it.name })
  }

  @Test
  fun `slider snaps and clamps to its step grid and reports Compose step count`() {
    assertEquals(4.0, snapOverlaySlider(3.6, 0.0, 10.0, 2.0), 0.0)
    assertEquals(10.0, snapOverlaySlider(99.0, 0.0, 10.0, 2.0), 0.0)
    assertEquals(0.0, snapOverlaySlider(-5.0, 0.0, 10.0, null), 0.0)
    assertEquals(3.3, snapOverlaySlider(3.2999, 0.0, 10.0, null), 0.0001)
    assertEquals(0.3, snapOverlaySlider(0.29, 0.0, 1.0, 0.1), 0.0)
    assertEquals(0, overlaySliderSteps(0.0, 10.0, null))
    assertEquals(4, overlaySliderSteps(0.0, 10.0, 2.0))
    assertEquals(0, overlaySliderSteps(0.0, 1.0, 1.0))
  }
}
