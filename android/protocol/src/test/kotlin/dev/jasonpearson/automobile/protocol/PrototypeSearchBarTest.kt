package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class PrototypeSearchBarTest {
  private val state =
    mapOf("query" to PrototypeScalar.Text(""), "active" to PrototypeScalar.BooleanValue(false))

  private fun spec(node: PrototypeNode) =
    PrototypeSpec("search", PrototypeWindow(PrototypeFullscreenPlacement()), state, node)

  private fun validate(node: PrototypeNode) =
    PrototypeSpecValidator.validate(Json.encodeToString(PrototypeSpec.serializer(), spec(node)))

  private fun rejects(node: PrototypeNode, path: String) {
    val result = validate(node)
    assertTrue(result is PrototypeSpecValidation.Failure, result.toString())
    assertEquals(path, (result as PrototypeSpecValidation.Failure).error.path)
  }

  @Test
  fun `both variants and active without a child round trip`() {
    for (variant in listOf(null, "bar", "docked")) {
      val node = PrototypeSearchBarNode(stateKey = "query", activeKey = "active", variant = variant)
      assertEquals(spec(node), (validate(node) as PrototypeSpecValidation.Success).spec)
    }
  }

  @Test
  fun `query and active bindings must exist and have their declared types`() {
    rejects(PrototypeSearchBarNode(stateKey = "active"), "root.stateKey")
    rejects(PrototypeSearchBarNode(stateKey = "missing"), "root.stateKey")
    rejects(PrototypeSearchBarNode(stateKey = "query", activeKey = "query"), "root.activeKey")
    rejects(PrototypeSearchBarNode(stateKey = "query", activeKey = "missing"), "root.activeKey")
    rejects(
      PrototypeSearchBarNode(stateKey = "query", child = PrototypeTextNode(text = "result")),
      "root.child",
    )
  }

  @Test
  fun `icons labels action bounds and variant use the shared structural rules`() {
    val node = PrototypeSearchBarNode(stateKey = "query")
    rejects(node.copy(leadingIcon = "unknown"), "root.leadingIcon")
    rejects(node.copy(variant = "floating"), "root.variant")
    rejects(node.copy(trailingActions = emptyList()), "root.trailingActions")
    rejects(
      node.copy(trailingActions = List(3) { PrototypeAppBarAction("search", "Search") }),
      "root.trailingActions",
    )
    rejects(
      node.copy(trailingActions = listOf(PrototypeAppBarAction("search", ""))),
      "root.trailingActions[0].label",
    )
    rejects(
      node.copy(trailingActions = listOf(PrototypeAppBarAction("unknown", "Search"))),
      "root.trailingActions[0].icon",
    )
  }

  @Test
  fun `submit trailing actions and inactive children validate their state writes`() {
    val invalid = listOf<PrototypeAction>(PrototypeToggleAction("query"))
    val node = PrototypeSearchBarNode(stateKey = "query", activeKey = "active")
    rejects(node.copy(onSubmit = invalid), "root.onSubmit[0].key")
    rejects(
      node.copy(trailingActions = listOf(PrototypeAppBarAction("search", "Search", invalid))),
      "root.trailingActions[0].onTap[0].key",
    )
    rejects(
      node.copy(child = PrototypeButtonNode(label = "Result", onTap = invalid)),
      "root.child.onTap[0].key",
    )
    rejects(
      node.copy(onSubmit = listOf(PrototypeSetStateAction("active", PrototypeScalar.Text("bad")))),
      "root.onSubmit[0].value",
    )
  }

  @Test
  fun `repeat validation binds active keys labels submit actions and child actions`() {
    val item =
      mapOf(
        "query" to PrototypeScalar.Text("query"),
        "active" to PrototypeScalar.Text("active"),
        "label" to PrototypeScalar.Text("Coffee"),
      )
    val template =
      PrototypeSearchBarNode(
        stateKey = "{item.query}",
        activeKey = "{item.active}",
        placeholder = "Find {item.label}",
        trailingActions = listOf(PrototypeAppBarAction("close", "Clear {item.label}")),
        onSubmit =
          listOf(PrototypeSetStateAction("{item.query}", PrototypeScalar.Text("{item.label}"))),
        child =
          PrototypeButtonNode(
            label = "{item.label}",
            onTap = listOf(PrototypeToggleAction("{item.active}")),
          ),
      )
    val root =
      PrototypeColumnNode(
        children = listOf(template),
        repeat = PrototypeRepeat(listOf(item), "item"),
      )
    assertTrue(validate(root) is PrototypeSpecValidation.Success)
    rejects(
      root.copy(children = listOf(template.copy(activeKey = "{item.query}"))),
      "root.children[0].activeKey",
    )
    rejects(
      root.copy(
        children = listOf(template.copy(onSubmit = listOf(PrototypeEmitAction("{item.missing}")))),
      ),
      "root.children[0].onSubmit[0].name",
    )
  }

  @Test
  fun `prepared state writes check both keys`() {
    val node = PrototypeSearchBarNode(stateKey = "query", activeKey = "active")
    val validator = PrototypeSpecValidator.prepareStateWrites(spec(node), Json)
    assertNull(validator.validate(state + ("query" to PrototypeScalar.Text("hello"))))
    assertEquals(
      "root.stateKey",
      validator.validate(state + ("query" to PrototypeScalar.Numeric(1.0)))?.path,
    )
    assertEquals(
      "root.activeKey",
      validator.validate(state + ("active" to PrototypeScalar.Text("bad")))?.path,
    )
  }

  @Test
  fun `inactive children still count towards node and depth limits and pager uniqueness`() {
    val node = PrototypeSearchBarNode(stateKey = "query", activeKey = "active")
    rejects(
      node.copy(
        child =
          PrototypeColumnNode(
            children = List(PrototypeSpecValidator.MAX_PROTOTYPE_NODES) { PrototypeSpacerNode() },
          ),
      ),
      "root.child.children[${PrototypeSpecValidator.MAX_PROTOTYPE_NODES - 2}]",
    )
    var deep: PrototypeNode = PrototypeSpacerNode()
    repeat(PrototypeSpecValidator.MAX_PROTOTYPE_DEPTH - 1) {
      deep = PrototypeScrollNode(child = deep)
    }
    rejects(
      node.copy(child = deep),
      "root" + ".child".repeat(PrototypeSpecValidator.MAX_PROTOTYPE_DEPTH),
    )
    val pager = PrototypePagerNode("same", children = listOf(PrototypeSpacerNode()))
    rejects(
      PrototypeColumnNode(children = listOf(pager, node.copy(child = pager))),
      "root.children[1].child.id",
    )
  }
}
