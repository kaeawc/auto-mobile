package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeMenusTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val open = PrototypeSheetCondition("open", true)
  private val options = listOf(PrototypeRadioOption("a", "A"), PrototypeRadioOption("b", "B"))

  private fun spec(root: PrototypeNode) =
    PrototypeSpec(
      "menus",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      mapOf("open" to PrototypeScalar.BooleanValue(true), "choice" to PrototypeScalar.Text("a")),
      root,
    )

  @Test
  fun `menu maps as an open modal and anchors to its parent`() {
    val root =
      mapPrototypeSpec(
          spec(
            PrototypeRowNode(
              children =
                listOf(
                  PrototypeButtonNode(label = "More"),
                  PrototypeMenuNode(openWhen = open, items = listOf(PrototypeMenuEntry("Go"))),
                ),
            ),
          ),
        )
        .root
    val menu = root.children[1]
    assertEquals("menu", menu.role)
    assertTrue(menu.sheetOpen)
    assertEquals(listOf(menu), modalPrototypeSheets(root))
    assertEquals(mapOf(menu.identity to root.identity), prototypeMenuParents(root))
    assertEquals(open, prototypeOpenWhen(menu.source))
  }

  @Test
  fun `select choice writes and emits the radio group change payload`() = runTest {
    val events = mutableListOf<PrototypeEvent>()
    var sequence = 0L
    val runtime =
      PrototypeRuntime(
        spec(PrototypeSelectNode(stateKey = "choice", options = options)),
        { events += it },
        { 42L },
        { ++sequence },
      )
    assertEquals("a", mapPrototypeSpec(runtime.current.spec).root.selectedValue)
    runtime.handle(
      PrototypeInteraction.Choose("choice", "b", listOf(PrototypeEmitAction("picked"))),
    )
    assertEquals(PrototypeScalar.Text("b"), runtime.current.state["choice"])
    assertEquals(listOf("change", "picked"), events.map { it.name })
    assertEquals("{\"key\":\"choice\",\"value\":\"b\"}", events.first().payload.toString())
  }

  @Test
  fun `menu item closes before actions and outside uses the same opposite write`() = runTest {
    val events = mutableListOf<PrototypeEvent>()
    var sequence = 0L
    val runtime =
      PrototypeRuntime(
        spec(PrototypeMenuNode(openWhen = open, items = listOf(PrototypeMenuEntry("Go")))),
        { events += it },
        { 42L },
        { ++sequence },
      )
    runtime.handle(PrototypeInteraction.CloseModal(open, listOf(PrototypeEmitAction("go"))))
    assertEquals(PrototypeScalar.BooleanValue(false), runtime.current.state["open"])
    assertEquals("go", events.last().name)
    assertEquals(PrototypeScalar.BooleanValue(false), events.last().state["open"])
    val inverse = PrototypeSheetCondition("open", false)
    runtime.handle(PrototypeInteraction.SheetDismiss(inverse))
    assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["open"])
  }

  @Test
  fun `repeat binds menu and select without modifying the template`() {
    val menu =
      PrototypeMenuNode(
        openWhen = PrototypeSheetCondition("{item.key}", true),
        items =
          listOf(
            PrototypeMenuEntry(
              "{item.label}",
              trailingText = "{item.label}",
              onTap =
                listOf(PrototypeSetStateAction("{item.key}", PrototypeScalar.BooleanValue(false))),
            ),
            PrototypeMenuDivider,
          ),
      )
    val select =
      PrototypeSelectNode(
        stateKey = "{item.choice}",
        label = "{item.label}",
        options = listOf(PrototypeRadioOption("a", "{item.label}"), PrototypeRadioOption("b", "B")),
      )
    val root =
      mapPrototypeSpec(
          spec(
            PrototypeColumnNode(
              children = listOf(menu, select),
              repeat =
                PrototypeRepeat(
                  listOf(
                    mapOf(
                      "key" to PrototypeScalar.Text("open"),
                      "choice" to PrototypeScalar.Text("choice"),
                      "label" to PrototypeScalar.Text("Bound"),
                    ),
                  ),
                  "item",
                ),
            ),
          ),
        )
        .root
    val boundMenu = root.children[0].source as PrototypeMenuNode
    val boundSelect = root.children[1].source as PrototypeSelectNode
    assertEquals("open", boundMenu.openWhen.key)
    assertEquals("Bound", (boundMenu.items[0] as PrototypeMenuEntry).label)
    assertEquals("Bound", (boundMenu.items[0] as PrototypeMenuEntry).trailingText)
    assertEquals(
      listOf(PrototypeSetStateAction("open", PrototypeScalar.BooleanValue(false))),
      (boundMenu.items[0] as PrototypeMenuEntry).onTap,
    )
    assertEquals("choice", boundSelect.stateKey)
    assertEquals("Bound", boundSelect.label)
    assertEquals("Bound", boundSelect.options[0].label)
    assertEquals("{item.key}", menu.openWhen.key)
  }
}
