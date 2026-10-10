package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/** Device-free mapping and runtime behaviour of `radioGroup` and `listItem` (#10439). */
class PrototypeSelectionComponentsTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val events = mutableListOf<PrototypeEvent>()
  private var sequence = 0L
  private val options =
    listOf(PrototypeRadioOption("chime", "Chime"), PrototypeRadioOption("beep", "Beep"))

  private fun spec(root: PrototypeNode, state: Map<String, PrototypeScalar>) =
    PrototypeSpec("panel", PrototypeWindow(PrototypeFullscreenPlacement()), state, root)

  private fun runtime(spec: PrototypeSpec) =
    PrototypeRuntime(spec, { events += it }, { 42L }, { ++sequence })

  @Test
  fun `radio group and list item map their role text and bound state`() {
    val state =
      mapOf(
        "sound" to PrototypeScalar.Text("beep"),
        "sync" to PrototypeScalar.BooleanValue(true),
        "wifi" to PrototypeScalar.BooleanValue(false),
      )
    val root =
      mapPrototypeSpec(
          spec(
            PrototypeColumnNode(
              children =
                listOf(
                  PrototypeRadioGroupNode(stateKey = "sound", options = options),
                  PrototypeListItemNode(
                    headline = "Sync",
                    trailing = PrototypeListItemSwitch("sync"),
                  ),
                  PrototypeListItemNode(
                    headline = "Wi-Fi",
                    trailing = PrototypeListItemCheckbox("wifi"),
                  ),
                  PrototypeListItemNode(
                    headline = "More",
                    trailing = PrototypeListItemIcon("menu"),
                  ),
                ),
            ),
            state,
          ),
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
      mapPrototypeSpec(
          spec(
            PrototypeRadioGroupNode(stateKey = "sound", options = options),
            mapOf("sound" to PrototypeScalar.Text("")),
          ),
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
          PrototypeRadioGroupNode(stateKey = "sound", options = options),
          mapOf("sound" to PrototypeScalar.Text("chime")),
        ),
      )
    runtime.handle(
      PrototypeInteraction.Choose("sound", "beep", listOf(PrototypeEmitAction("picked"))),
    )
    assertEquals(PrototypeScalar.Text("beep"), runtime.current.state["sound"])
    assertEquals(listOf("change", "picked"), events.map { it.name })
    assertEquals(
      "{\"key\":\"sound\",\"value\":\"beep\"}",
      events.first().payload.toString(),
    )
    runtime.handle(PrototypeInteraction.Choose("sound", "beep"))
    assertEquals(2, events.size)
  }

  @Test
  fun `choose on a key that is not a string is inert`() = runTest {
    val runtime = runtime(spec(PrototypeSpacerNode(), mapOf("n" to PrototypeScalar.Numeric(1.0))))
    runtime.handle(PrototypeInteraction.Choose("n", "x", listOf(PrototypeEmitAction("picked"))))
    runtime.handle(PrototypeInteraction.Choose("missing", "x"))
    assertEquals(PrototypeScalar.Numeric(1.0), runtime.current.state["n"])
    assertTrue(events.isEmpty())
  }

  @Test
  fun `setState cannot retype a radio group binding`() = runTest {
    val runtime =
      runtime(
        spec(
          PrototypeRadioGroupNode(stateKey = "sound", options = options),
          mapOf("sound" to PrototypeScalar.Text("chime")),
        ),
      )
    val error = runCatching {
      runtime.handle(
        PrototypeInteraction.Tap(
          listOf(PrototypeSetStateAction("sound", PrototypeScalar.Numeric(1.0))),
        ),
      )
    }
      .exceptionOrNull()
    assertTrue("$error", error is IllegalArgumentException)
    assertEquals(PrototypeScalar.Text("chime"), runtime.current.state["sound"])
  }

  @Test
  fun `a list item trailing toggle flips its key through the same toggle interaction`() = runTest {
    val node = PrototypeListItemNode(headline = "Sync", trailing = PrototypeListItemSwitch("sync"))
    val runtime = runtime(spec(node, mapOf("sync" to PrototypeScalar.BooleanValue(false))))
    assertEquals("sync", prototypeListItemToggleKey(node))
    assertNull(prototypeListItemToggleKey(PrototypeListItemNode(headline = "H")))
    runtime.handle(PrototypeInteraction.Toggle("sync"))
    assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["sync"])
    assertEquals(listOf("change"), events.map { it.name })
  }

  @Test
  fun `option tags join the group tag and the option value`() {
    assertEquals("sound.beep", prototypeRadioOptionTag("sound", "beep"))
    assertNull(prototypeRadioOptionTag(null, "beep"))
  }
}
