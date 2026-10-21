package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Test

class PrototypeSearchBarRenderModelTest {
  private val field =
    PrototypeSearchBarNode(
      stateKey = "query",
      activeKey = "active",
      testTag = "search",
      contentDescription = "Find {query}",
      placeholder = "Search",
      child = PrototypeTextNode(text = "Results"),
    )

  private fun spec(active: Boolean, root: PrototypeNode = field) =
    PrototypeSpec(
      "search",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      mapOf(
        "query" to PrototypeScalar.Text("coffee"),
        "active" to PrototypeScalar.BooleanValue(active),
      ),
      root,
    )

  @Test
  fun `query description and child visibility follow state including cached remapping`() {
    val mapper = PrototypeRenderMapper()
    for (active in listOf(false, true, false)) {
      val model = mapper.map(spec(active), emptyMap())
      assertEquals("searchBar", model.root.role)
      assertEquals("coffee", model.root.text)
      assertEquals("Find coffee", model.root.contentDescription)
      assertEquals(if (active) 1 else 0, model.root.children.size)
      if (active) assertEquals("Results", model.root.children.single().text)
      assertEquals(active, model.root.sheetOpen)
      assertTrue(model.hasTextField)
    }
    assertFalse(
      mapPrototypeSpec(
          spec(
            true,
            field.copy(
              visibleWhen =
                PrototypeCondition(key = "active", equals = PrototypeScalar.BooleanValue(false)),
            ),
          ),
        )
        .hasTextField,
    )
  }

  @Test
  fun `repeat binds query active placeholder trailing labels submit and child subtree`() {
    val action = PrototypeSetStateAction("{item.query}", PrototypeScalar.Text("{item.label}"))
    val template =
      field.copy(
        stateKey = "{item.query}",
        activeKey = "{item.active}",
        placeholder = "Find {item.label}",
        onSubmit = listOf(action),
        trailingActions =
          listOf(PrototypeAppBarAction("search", "Search {item.label}", listOf(action))),
        child = PrototypeButtonNode(label = "Result {item.label}", onTap = listOf(action)),
      )
    val root =
      PrototypeColumnNode(
        children = listOf(template),
        repeat =
          PrototypeRepeat(
            items =
              listOf(
                mapOf(
                  "query" to PrototypeScalar.Text("query"),
                  "active" to PrototypeScalar.Text("active"),
                  "label" to PrototypeScalar.Text("coffee"),
                ),
              ),
            `as` = "item",
          ),
      )
    val mapped = mapPrototypeSpec(spec(true, root)).root.children.single()
    val bound = mapped.source as PrototypeSearchBarNode
    assertEquals("query", bound.stateKey)
    assertEquals("active", bound.activeKey)
    assertEquals("Find coffee", bound.placeholder)
    assertEquals("Search coffee", bound.trailingActions?.single()?.label)
    val expected = listOf(PrototypeSetStateAction("query", PrototypeScalar.Text("coffee")))
    assertEquals(expected, bound.onSubmit)
    assertEquals(expected, bound.trailingActions?.single()?.onTap)
    assertEquals("Result coffee", mapped.children.single().text)
    assertEquals(expected, mapped.children.single().source?.onTap)
    assertEquals("root.repeat[0].children[0].child", mapped.children.single().identity)
  }
}
