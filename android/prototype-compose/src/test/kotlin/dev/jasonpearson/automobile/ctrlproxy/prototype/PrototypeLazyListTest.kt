package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeLazyListTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmMapping() {
      PrototypeMenuLayers().expandedSelect = "warm"
      mapPrototypeSpec(PrototypeLazyListTest().spec(1))
      PrototypeLazyListTest()
        .`lazy fields keep per item checks and reserve input without eager rendered children`()
    }
  }

  @Test
  fun `end trigger deduplicates signatures including a sliding fixed size window`() {
    val trigger = PrototypeListEndTrigger(3)
    assertFalse(trigger.onVisibleRange(0, 0, null))
    assertFalse(trigger.onVisibleRange(6, 10, "ten"))
    assertTrue(trigger.onVisibleRange(7, 10, "ten"))
    assertFalse(trigger.onVisibleRange(9, 10, "ten"))
    assertFalse(trigger.onVisibleRange(0, 10, "ten"))
    assertFalse(trigger.onVisibleRange(9, 10, "ten"))
    assertTrue(trigger.onVisibleRange(9, 10, "eleven"))
    assertTrue(trigger.onVisibleRange(10, 11, "twelve"))
    assertTrue(PrototypeListEndTrigger(3).onVisibleRange(9, 10, "ten"))
  }

  @Test
  fun `show holder retains triggers after list disposal and isolates paths and shows`() {
    val holder = PrototypeListEndTriggers()
    assertTrue(holder.get("root.screens.feed", 3).onVisibleRange(9, 10, "ten"))
    assertFalse(holder.get("root.screens.feed", 3).onVisibleRange(9, 10, "ten"))
    assertTrue(holder.get("root.screens.other", 3).onVisibleRange(9, 10, "ten"))
    assertTrue(holder.get("root.screens.feed", 3).onVisibleRange(9, 10, "eleven"))
    assertTrue(PrototypeListEndTriggers().get("root.screens.feed", 3).onVisibleRange(9, 10, "ten"))
  }

  internal fun spec(
    count: Int = PrototypeSpecValidator.MAX_PROTOTYPE_LIST_ITEMS,
    axis: String = "vertical",
  ): PrototypeSpec {
    val list =
      PrototypeListNode(
        testTag = "feed",
        contentDescription = "Posts",
        axis = axis,
        repeat = PrototypeRepeat(emptyList(), "post", "/items", "id"),
        children =
          listOf(
            PrototypeTextNode(
              text = "{index}: {post.title}",
              testTag = "row",
              style = PrototypeStyle(height = PrototypeDimension.Dp(40.0)),
            ),
          ),
        header = PrototypeTextNode(text = "Feed"),
        footer = PrototypeTextNode(text = "End"),
        refresh =
          if (axis == "vertical")
            PrototypeScrollRefresh("refreshing", listOf(PrototypeEmitAction("refresh")))
          else null,
      )
    return PrototypeSpec(
      "feed",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root = list,
      state = mapOf("refreshing" to PrototypeScalar.BooleanValue(true)),
      data =
        buildJsonObject {
          put(
            "items",
            JsonArray(
              (0 until count).map {
                buildJsonObject {
                  put("id", it)
                  put("title", "Post $it")
                }
              },
            ),
          )
        },
    )
  }

  @Test
  fun `rows at the list limit count the template once and bind only on demand`() {
    val model = mapPrototypeSpec(spec()).root
    assertEquals("list", model.role)
    assertEquals(listOf("Feed", "End"), model.children.map { it.text })
    val list = checkNotNull(model.list)
    val last = PrototypeSpecValidator.MAX_PROTOTYPE_LIST_ITEMS - 1
    assertEquals(last + 1, list.rows.size)
    assertEquals("$last", list.key(last))
    assertEquals("$last: Post $last", list.render(list.rows[last], last).text)
    assertEquals("Posts", model.contentDescription)
    assertTrue(model.checked)
    assertEquals(
      listOf(
        PrototypeSetStateAction("refreshing", PrototypeScalar.BooleanValue(true)),
        PrototypeEmitAction("refresh"),
      ),
      prototypeRefreshActions(checkNotNull(list.source.refresh)),
    )
  }

  @Test
  fun `lazy fields keep per item checks and reserve input without eager rendered children`() {
    val original = spec(2)
    val root =
      (original.root as PrototypeListNode).copy(
        children =
          listOf(
            PrototypeTextFieldNode(
              stateKey = "field_{post.id}",
              checks = listOf(PrototypeCheck.Required("Required")),
            ),
          ),
      )
    val spec =
      original.copy(
        root = root,
        state =
          original.state.orEmpty() +
            mapOf(
              "field_0" to PrototypeScalar.Text(""),
              "field_1" to PrototypeScalar.Text("Ready"),
            ),
      )
    val model = mapPrototypeSpec(spec)
    assertTrue(model.hasTextField)
    assertEquals(2, model.root.children.size)
    assertEquals(
      mapOf("field_0" to false, "field_1" to true),
      prototypeValidity(checkedPrototypeNodes(root, spec.data), spec.state.orEmpty()),
    )
  }

  @Test
  fun `lazy row select remains discoverable while expanded`() {
    val base = spec(2)
    val root =
      mapPrototypeSpec(
          base.copy(
            root =
              (base.root as PrototypeListNode).copy(
                children =
                  listOf(
                    PrototypeSelectNode(
                      stateKey = "choice_{post.id}",
                      options = listOf(PrototypeRadioOption("a", "{post.title}")),
                    ),
                  ),
              ),
          ),
        )
        .root
    val list = checkNotNull(root.list)
    val row = list.render(list.rows[1], 1)
    val layers = PrototypeMenuLayers()
    layers.expandedSelect = row.identity
    val select = visiblePrototypeSelect(root, checkNotNull(layers.expandedSelect))
    if (select == null) layers.expandedSelect = null
    assertEquals(row.identity, layers.expandedSelect)
    val source = checkNotNull(select).source as PrototypeSelectNode
    assertEquals("choice_1", source.stateKey)
    assertEquals("Post 1", source.options.single().label)
    assertEquals(listOf("Feed", "End"), root.children.map { it.text })
    assertNull(visiblePrototypeSelect(root.copy(visible = false), row.identity))
    assertNull(visiblePrototypeSelect(root, "root.children[0]"))
  }

  private fun dataList(text: String, data: String): PrototypeSpec {
    val base = spec(0)
    return base.copy(
      root =
        (base.root as PrototypeListNode).copy(
          repeat = PrototypeRepeat(emptyList(), "row", "/rows", "id"),
          children = listOf(PrototypeTextNode(text = text)),
        ),
      data = Json.parseToJsonElement(data).jsonObject,
    )
  }

  @Test
  fun `lazy data pointers bind the row index before resolving`() {
    val input =
      dataList(
        "{data:/rows/{index}/name}",
        """{"rows":[{"id":"a","name":"First"},{"id":"b","name":"Second"}]}""",
      )
    val model = checkNotNull(mapPrototypeSpec(PrototypeDataResolver.resolve(input)).root.list)
    assertEquals("First", model.render(model.rows[0], 0).text)
    assertEquals("Second", model.render(model.rows[1], 1).text)
  }

  @Test
  fun `lazy data pointers bind row fields before resolving`() {
    val input =
      dataList(
        "{data:/posts/{row.id}/title}",
        """{"rows":[{"id":"a"},{"id":"b"}],"posts":{"a":{"title":"Alpha"},"b":{"title":"Beta"}}}""",
      )
    val model = checkNotNull(mapPrototypeSpec(input).root.list)
    assertEquals("Alpha", model.render(model.rows[0], 0).text)
    assertEquals("Beta", model.render(model.rows[1], 1).text)
  }

  @Test
  fun `lazy data values containing row and data tokens stay literal`() {
    val input =
      dataList(
        "{data:/literal}",
        """{"rows":[{"id":"a","x":"Expanded"}],"literal":"{row.x} {index} {data:/other}","other":"Expanded"}""",
      )
    val model = checkNotNull(mapPrototypeSpec(input).root.list)
    assertEquals("{row.x} {index} {data:/other}", model.render(model.rows.single(), 0).text)
  }

  @Test
  fun `lazy row values that look like data or platform tokens stay literal`() {
    val input =
      dataList(
        "{row.name}",
        """{"rows":[{"id":"a","name":"{data:/other}"},{"id":"b","name":"{platform:/device/widthClass}"}],"other":"Expanded"}""",
      )
    val model = checkNotNull(mapPrototypeSpec(input).root.list)
    assertEquals("{data:/other}", model.render(model.rows[0], 0).text)
    assertEquals("{platform:/device/widthClass}", model.render(model.rows[1], 1).text)
  }

  @Test
  fun `nested repeat binds inner row data last and retains its outer alias`() {
    val base =
      dataList(
        "unused",
        """{"rows":[{"id":"a","cells":[{"id":"c"}]}],"label":"Cell","titles":{"c":"{cell.id} {row.id}"}}""",
      )
    val template =
      PrototypeColumnNode(
        semantics = PrototypeSemantics(label = "{data:/label}"),
        repeat = PrototypeRepeat(emptyList(), "cell", itemsField = "cells"),
        children = listOf(PrototypeTextNode(text = "{row.id}: {data:/titles/{cell.id}}")),
      )
    val input = base.copy(root = (base.root as PrototypeListNode).copy(children = listOf(template)))
    val model = checkNotNull(mapPrototypeSpec(input).root.list)
    val row = model.render(model.rows.single(), 0)
    assertEquals("Cell", row.contentDescription)
    assertEquals("a: {cell.id} {row.id}", row.children.single().text)
  }

  @Test
  fun `empty lists retain their header and footer and have no rows`() {
    val model = mapPrototypeSpec(spec(0)).root
    assertTrue(checkNotNull(model.list).rows.isEmpty())
    assertEquals(listOf("Feed", "End"), model.children.map { it.text })
  }
}
