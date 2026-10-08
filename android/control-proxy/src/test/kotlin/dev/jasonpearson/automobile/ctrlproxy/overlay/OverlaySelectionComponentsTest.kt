package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/** Device-free mapping and runtime behaviour of `radioGroup` and `listItem` (#10439). */
class OverlaySelectionComponentsTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      OverlaySpecValidator.validate("{}")
    }
  }

  private val events = mutableListOf<OverlayEvent>()
  private var sequence = 0L
  private val options =
    listOf(OverlayRadioOption("chime", "Chime"), OverlayRadioOption("beep", "Beep"))

  private fun spec(root: OverlayNode, state: Map<String, OverlayScalar>) =
    OverlaySpec("panel", OverlayWindow(OverlayFullscreenPlacement()), state, root)

  private fun runtime(spec: OverlaySpec) =
    OverlayRuntime(spec, { events += it }, { 42L }, { ++sequence })

  @Test
  fun `radio group and list item map their role text and bound state`() {
    val state =
      mapOf(
        "sound" to OverlayScalar.Text("beep"),
        "sync" to OverlayScalar.BooleanValue(true),
        "wifi" to OverlayScalar.BooleanValue(false),
      )
    val root =
      mapOverlaySpec(
          spec(
            OverlayColumnNode(
              children =
                listOf(
                  OverlayRadioGroupNode(stateKey = "sound", options = options),
                  OverlayListItemNode(
                    headline = "Sync",
                    trailing = OverlayListItemSwitch("sync"),
                  ),
                  OverlayListItemNode(
                    headline = "Wi-Fi",
                    trailing = OverlayListItemCheckbox("wifi"),
                  ),
                  OverlayListItemNode(headline = "More", trailing = OverlayListItemIcon("menu")),
                )
            ),
            state,
          )
        )
        .root
    val (radio, sync, wifi, more) = root.children
    assertEquals(
      listOf("radioGroup", "listItem", "listItem", "listItem"),
      root.children.map { it.role },
    )
    assertEquals(listOf("", "Sync", "Wi-Fi", "More"), root.children.map { it.text })
    assertEquals("beep", radio.selectedValue)
    assertTrue(sync.checked)
    assertFalse(wifi.checked)
    assertFalse(more.checked)
    assertNull(sync.selectedValue)
  }

  @Test
  fun `a bound value that matches no option selects nothing`() {
    val root =
      mapOverlaySpec(
          spec(
            OverlayRadioGroupNode(stateKey = "sound", options = options),
            mapOf("sound" to OverlayScalar.Text("")),
          )
        )
        .root
    assertEquals("", root.selectedValue)
    assertTrue(options.none { it.value == root.selectedValue })
  }

  @Test
  fun `choose binds the string key emits change once then runs the group actions`() = runTest {
    val runtime =
      runtime(
        spec(
          OverlayRadioGroupNode(stateKey = "sound", options = options),
          mapOf("sound" to OverlayScalar.Text("chime")),
        )
      )
    runtime.handle(OverlayInteraction.Choose("sound", "beep", listOf(OverlayEmitAction("picked"))))
    assertEquals(OverlayScalar.Text("beep"), runtime.current.state["sound"])
    assertEquals(listOf("change", "picked"), events.map { it.name })
    assertEquals(
      "{\"key\":\"sound\",\"value\":\"beep\"}",
      events.first().payload.toString(),
    )
    runtime.handle(OverlayInteraction.Choose("sound", "beep"))
    assertEquals(2, events.size)
  }

  @Test
  fun `choose on a key that is not a string is inert`() = runTest {
    val runtime = runtime(spec(OverlaySpacerNode(), mapOf("n" to OverlayScalar.Numeric(1.0))))
    runtime.handle(OverlayInteraction.Choose("n", "x", listOf(OverlayEmitAction("picked"))))
    runtime.handle(OverlayInteraction.Choose("missing", "x"))
    assertEquals(OverlayScalar.Numeric(1.0), runtime.current.state["n"])
    assertTrue(events.isEmpty())
  }

  @Test
  fun `setState cannot retype a radio group binding`() = runTest {
    val runtime =
      runtime(
        spec(
          OverlayRadioGroupNode(stateKey = "sound", options = options),
          mapOf("sound" to OverlayScalar.Text("chime")),
        )
      )
    val error = runCatching {
      runtime.handle(
        OverlayInteraction.Tap(listOf(OverlaySetStateAction("sound", OverlayScalar.Numeric(1.0))))
      )
    }
      .exceptionOrNull()
    assertTrue("$error", error is IllegalArgumentException)
    assertEquals(OverlayScalar.Text("chime"), runtime.current.state["sound"])
  }

  @Test
  fun `a list item trailing toggle flips its key through the same toggle interaction`() = runTest {
    val node = OverlayListItemNode(headline = "Sync", trailing = OverlayListItemSwitch("sync"))
    val runtime = runtime(spec(node, mapOf("sync" to OverlayScalar.BooleanValue(false))))
    assertEquals("sync", overlayListItemToggleKey(node))
    assertNull(overlayListItemToggleKey(OverlayListItemNode(headline = "H")))
    runtime.handle(OverlayInteraction.Toggle("sync"))
    assertEquals(OverlayScalar.BooleanValue(true), runtime.current.state["sync"])
    assertEquals(listOf("change"), events.map { it.name })
  }

  @Test
  fun `option tags join the group tag and the option value`() {
    assertEquals("sound.beep", overlayRadioOptionTag("sound", "beep"))
    assertNull(overlayRadioOptionTag(null, "beep"))
  }
}
