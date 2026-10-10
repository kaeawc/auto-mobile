package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/** Device-free mapping and runtime behaviour of the Material component nodes (#10439). */
class PrototypeComponentsTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val events = mutableListOf<PrototypeEvent>()
  private var sequence = 0L

  private fun spec(root: PrototypeNode, state: Map<String, PrototypeScalar>) =
    PrototypeSpec("panel", PrototypeWindow(PrototypeFullscreenPlacement()), state, root)

  private fun runtime(spec: PrototypeSpec) =
    PrototypeRuntime(spec, { events += it }, { 42L }, { ++sequence })

  @Test
  fun `switch checkbox and button map their role label and bound state`() {
    val state = mapOf("on" to PrototypeScalar.BooleanValue(true))
    val root =
      mapPrototypeSpec(
          spec(
            PrototypeColumnNode(
              children =
                listOf(
                  PrototypeSwitchNode(stateKey = "on", label = "Alarm"),
                  PrototypeCheckboxNode(stateKey = "off"),
                  PrototypeButtonNode(label = "Save", variant = "outlined"),
                ),
            ),
            state + ("off" to PrototypeScalar.BooleanValue(false)),
          ),
        )
        .root
    val (switch, checkbox, button) = root.children
    assertEquals(listOf("switch", "checkbox", "button"), root.children.map { it.role })
    assertEquals(listOf("Alarm", "", "Save"), root.children.map { it.text })
    assertTrue(switch.checked)
    assertFalse(checkbox.checked)
    assertFalse(button.checked)
    assertEquals("checkbox", prototypeContentDescription("checkbox", "", null, tappable = false))
  }

  @Test
  fun `toggle flips the bound boolean emits change then runs the node actions`() = runTest {
    val runtime =
      runtime(
        spec(
          PrototypeSwitchNode(stateKey = "on"),
          mapOf("on" to PrototypeScalar.BooleanValue(false)),
        ),
      )
    runtime.handle(PrototypeInteraction.Toggle("on", listOf(PrototypeEmitAction("tapped"))))
    assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["on"])
    assertEquals(listOf("change", "tapped"), events.map { it.name })
    assertEquals(
      buildJsonObject {
        put("key", "on")
        put("value", true)
      },
      events.first().payload,
    )
    assertEquals(mapOf("on" to PrototypeScalar.BooleanValue(true)), events.first().state)
    runtime.handle(PrototypeInteraction.Toggle("on"))
    assertEquals(PrototypeScalar.BooleanValue(false), runtime.current.state["on"])
    assertEquals(3, events.size)
  }

  @Test
  fun `a toggle on a key that is not a boolean is inert`() = runTest {
    val runtime =
      runtime(spec(PrototypeSpacerNode(), mapOf("count" to PrototypeScalar.Numeric(1.0))))
    runtime.handle(PrototypeInteraction.Toggle("count", listOf(PrototypeEmitAction("tapped"))))
    runtime.handle(PrototypeInteraction.Toggle("missing"))
    assertEquals(PrototypeScalar.Numeric(1.0), runtime.current.state["count"])
    assertTrue(events.isEmpty())
  }

  @Test
  fun `setState cannot retype a toggle binding`() = runTest {
    val runtime =
      runtime(
        spec(
          PrototypeSwitchNode(stateKey = "on"),
          mapOf("on" to PrototypeScalar.BooleanValue(true)),
        ),
      )
    val error = runCatching {
      runtime.handle(
        PrototypeInteraction.Tap(
          listOf(PrototypeSetStateAction("on", PrototypeScalar.Text("yes"))),
        ),
      )
    }
      .exceptionOrNull()
    assertTrue("$error", error is IllegalArgumentException)
    assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["on"])
  }

  @Test
  fun `slider chip and card map their role label bound value and children`() {
    val state =
      mapOf(
        "volume" to PrototypeScalar.Numeric(7.0),
        "mon" to PrototypeScalar.BooleanValue(true),
      )
    val root =
      mapPrototypeSpec(
          spec(
            PrototypeColumnNode(
              children =
                listOf(
                  PrototypeSliderNode(stateKey = "volume", label = "Volume", min = 0.0, max = 10.0),
                  PrototypeChipNode(label = "Mon", stateKey = "mon"),
                  PrototypeChipNode(label = "Add"),
                  PrototypeCardNode(
                    variant = "elevated",
                    children = listOf(PrototypeButtonNode(label = "Save")),
                  ),
                ),
            ),
            state,
          ),
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
    assertNull(prototypeContentDescription("card", "", null, tappable = false))
  }

  @Test
  fun `a card counts toward the node limit through its children`() {
    val deep =
      PrototypeCardNode(
        children = List(PrototypeSpecValidator.MAX_PROTOTYPE_NODES) { PrototypeSpacerNode() },
      )
    val error = runCatching { mapPrototypeSpec(spec(deep, emptyMap())) }.exceptionOrNull()
    assertTrue("$error", error is IllegalArgumentException)
  }

  @Test
  fun `slide stores the number emits change then runs the node actions`() = runTest {
    val runtime =
      runtime(
        spec(
          PrototypeSliderNode(stateKey = "v", min = 0.0, max = 10.0),
          mapOf("v" to PrototypeScalar.Numeric(2.0)),
        ),
      )
    runtime.handle(PrototypeInteraction.Slide("v", 5.0, listOf(PrototypeEmitAction("moved"))))
    assertEquals(PrototypeScalar.Numeric(5.0), runtime.current.state["v"])
    assertEquals(listOf("change", "moved"), events.map { it.name })
    assertEquals(
      buildJsonObject {
        put("key", "v")
        put("value", 5.0)
      },
      events.first().payload,
    )
    runtime.handle(PrototypeInteraction.Slide("v", 5.0, listOf(PrototypeEmitAction("moved"))))
    assertEquals(2, events.size)
  }

  @Test
  fun `slide on a key that is not a number is inert and out of range values are rejected`() =
    runTest {
      val runtime =
        runtime(
          spec(
            PrototypeSliderNode(stateKey = "v", min = 0.0, max = 10.0),
            mapOf(
              "v" to PrototypeScalar.Numeric(2.0),
              "flag" to PrototypeScalar.BooleanValue(true),
            ),
          ),
        )
      runtime.handle(PrototypeInteraction.Slide("flag", 3.0))
      runtime.handle(PrototypeInteraction.Slide("missing", 3.0))
      assertTrue(events.isEmpty())
      val error = runCatching {
        runtime.handle(PrototypeInteraction.Slide("v", 11.0))
      }
        .exceptionOrNull()
      assertTrue("$error", error is IllegalArgumentException)
      assertEquals(PrototypeScalar.Numeric(2.0), runtime.current.state["v"])
    }

  @Test
  fun `a filter chip toggles through the shared toggle interaction`() = runTest {
    val runtime =
      runtime(
        spec(
          PrototypeChipNode(label = "Mon", stateKey = "mon"),
          mapOf("mon" to PrototypeScalar.BooleanValue(false)),
        ),
      )
    runtime.handle(PrototypeInteraction.Toggle("mon"))
    assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["mon"])
    assertEquals(listOf("change"), events.map { it.name })
  }

  @Test
  fun `slider snaps and clamps to its step grid and reports Compose step count`() {
    assertEquals(4.0, snapPrototypeSlider(3.6, 0.0, 10.0, 2.0), 0.0)
    assertEquals(10.0, snapPrototypeSlider(99.0, 0.0, 10.0, 2.0), 0.0)
    assertEquals(0.0, snapPrototypeSlider(-5.0, 0.0, 10.0, null), 0.0)
    assertEquals(3.3, snapPrototypeSlider(3.2999, 0.0, 10.0, null), 0.0001)
    assertEquals(0.3, snapPrototypeSlider(0.29, 0.0, 1.0, 0.1), 0.0)
    assertEquals(0, prototypeSliderSteps(0.0, 10.0, null))
    assertEquals(4, prototypeSliderSteps(0.0, 10.0, 2.0))
    assertEquals(0, prototypeSliderSteps(0.0, 1.0, 1.0))
  }
}
