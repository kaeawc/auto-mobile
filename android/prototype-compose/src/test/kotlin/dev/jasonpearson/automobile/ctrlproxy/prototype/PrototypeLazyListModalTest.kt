package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeLazyListModalTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmMapping() {
      mapPrototypeSpec(PrototypeLazyListModalTest().spec(true))
    }
  }

  private fun spec(open: Boolean): PrototypeSpec =
    PrototypeSpec(
      "lazy-modal",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      state = mapOf("open" to PrototypeScalar.BooleanValue(open)),
      data =
        buildJsonObject {
          putJsonObject("rows") {
            putJsonArray("items") {
              listOf("Alpha", "Beta").forEach { title ->
                addJsonObject {
                  put("id", title.lowercase())
                  put("title", title)
                }
              }
            }
          }
        },
      root =
        PrototypeColumnNode(
          children =
            listOf(
              PrototypeTextNode(text = "HEADER"),
              PrototypeListNode(
                repeat = PrototypeRepeat(emptyList(), "it", "/rows/items", "id"),
                children =
                  listOf(
                    PrototypeRowNode(
                      children =
                        listOf(
                          PrototypeTextNode(text = "Row {it.title}"),
                          PrototypeButtonNode(
                            label = "Open {it.title}",
                            onTap =
                              listOf(
                                PrototypeSetStateAction("open", PrototypeScalar.BooleanValue(true)),
                              ),
                          ),
                          rowSheet(),
                        ),
                    ),
                  ),
              ),
              PrototypeTextNode(text = "FOOTER open={open}"),
            ),
        ),
    )

  private fun rowSheet(): PrototypeBottomSheetNode =
    PrototypeBottomSheetNode(
      openWhen = PrototypeSheetCondition("open", true),
      detents = listOf(PrototypeDetent.Half),
      scrim = PrototypeModeValue.Single("#80000000"),
      child =
        PrototypeColumnNode(
          children =
            listOf(
              PrototypeTextNode(text = "SHEET CONTENT {it.title}"),
              PrototypeButtonNode(
                label = "Close",
                onTap =
                  listOf(
                    PrototypeSetStateAction(
                      "open",
                      PrototypeScalar.BooleanValue(false),
                    ),
                  ),
              ),
            ),
        ),
    )

  @Test
  fun `open repeated sheets are hoisted once per keyed row and closed sheets are absent`() {
    val root = mapPrototypeSpec(spec(true)).root
    val sheets = modalPrototypeSheets(root)
    assertEquals(listOf("bottomSheet", "bottomSheet"), sheets.map { it.role })
    assertTrue(sheets.all { it.sheetOpen })
    assertEquals(
      listOf("SHEET CONTENT Alpha", "SHEET CONTENT Beta"),
      sheets.map { it.children.single().children.first().text },
    )
    assertEquals(2, sheets.map { it.identity }.toSet().size)
    val list = checkNotNull(root.children[1].list)
    sheets.forEachIndexed { index, sheet ->
      assertEquals(list.render(list.rows[index], index).children[2].identity, sheet.identity)
    }
    assertTrue(root.children[1].children.isEmpty())

    val closed = mapPrototypeSpec(spec(false)).root
    assertTrue(modalPrototypeSheets(closed).isEmpty())
    val closing = modalPrototypeSheets(closed, includeClosedDrawers = true)
    assertEquals(sheets.map { it.identity }, closing.map { it.identity })
    assertTrue(closing.all { !it.sheetOpen })
  }

  @Test
  fun `collecting modals never maps rows of a modal free list`() {
    val root = mapPrototypeSpec(PrototypeLazyListTest().spec()).root
    val original = checkNotNull(root.list)
    var renders = 0
    val observed =
      root.copy(
        list =
          PrototypeLazyListModel(original.source, original.rows, original.snapshot) { item, index ->
            renders++
            original.render(item, index)
          },
      )
    assertTrue(modalPrototypeSheets(observed).isEmpty())
    assertTrue(modalPrototypeSheets(observed, includeClosedDrawers = true).isEmpty())
    assertEquals(0, renders)
    assertEquals(listOf("Feed", "End"), observed.children.map { it.text })
  }
}
