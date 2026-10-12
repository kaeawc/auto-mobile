package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import java.io.File
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class PrototypeRepeatTest {
  private val items =
    listOf(
      mapOf(
        "id" to PrototypeScalar.Text("a"),
        "label" to PrototypeScalar.Text("Alpha"),
        "price" to PrototypeScalar.Numeric(3.0),
        "on" to PrototypeScalar.BooleanValue(true),
      ),
      mapOf(
        "id" to PrototypeScalar.Numeric(7.0),
        "label" to PrototypeScalar.Text("Beta"),
        "price" to PrototypeScalar.Numeric(4.5),
        "on" to PrototypeScalar.BooleanValue(false),
      ),
    )

  private fun spec(root: PrototypeNode, state: Map<String, PrototypeScalar>? = null) =
    PrototypeSpec("panel", PrototypeWindow(PrototypeFullscreenPlacement()), state, root)

  private fun list(
    vararg template: PrototypeNode,
    repeat: List<Map<String, PrototypeScalar>> = items,
  ) =
    PrototypeColumnNode(
      children = template.toList(),
      repeat = PrototypeRepeat(repeat, "item"),
    )

  @Test
  fun `children are instantiated per item with text bound and stable per index identities`() {
    val model =
      mapPrototypeSpec(
        spec(
          list(
            PrototypeTextNode(
              text = "{index}: {item.label} costs {item.price} ({item.on}) {other.x}",
            ),
            PrototypeRowNode(children = listOf(PrototypeTextNode(text = "{item.label}!"))),
          ),
        ),
      )
    val rows = model.root.children
    assertEquals(
      listOf(
        "0: Alpha costs 3 (true) {other.x}",
        "",
        "1: Beta costs 4.5 (false) {other.x}",
        "",
      ),
      rows.map { it.text },
    )
    assertEquals(
      listOf(
        "root.repeat[0].children[0]",
        "root.repeat[0].children[1]",
        "root.repeat[1].children[0]",
        "root.repeat[1].children[1]",
      ),
      rows.map { it.identity },
    )
    assertEquals("Beta!", rows[3].children.single().text)
    assertEquals("root.repeat[1].children[1].children[0]", rows[3].children.single().identity)
  }

  @Test
  fun `conditions and actions bind with typed whole placeholder operands`() {
    val node =
      PrototypeTextNode(
        text = "row",
        visibleWhen = PrototypeCondition("picked", notEquals = PrototypeScalar.Text("{item.id}")),
        styleWhen =
          listOf(
            PrototypeStyleWhen(
              PrototypeCondition(
                all =
                  listOf(
                    PrototypeCondition("picked", equals = PrototypeScalar.Text("{item.id}")),
                    PrototypeCondition(
                      not = PrototypeCondition("slot", equals = PrototypeScalar.Text("{index}")),
                    ),
                  ),
              ),
              PrototypeStyle(background = PrototypeModeValue.Single("#2255CC")),
            ),
          ),
        onTap =
          listOf(
            PrototypeSetStateAction("picked", PrototypeScalar.Text("{item.id}")),
            PrototypeSetStateAction("label", PrototypeScalar.Text("row {index}")),
            PrototypeSetStateAction("slot", PrototypeScalar.Text("{index}")),
            PrototypeEmitAction("pick_{item.id}"),
            PrototypeDismissAction,
          ),
      )
    val state =
      mapOf("picked" to PrototypeScalar.Numeric(7.0), "slot" to PrototypeScalar.Numeric(9.0))
    val rows = mapPrototypeSpec(spec(list(node), state)).root.children
    // Item 0 has the text id "a" (not picked); item 1 has the numeric id 7, matching typed state.
    assertEquals(listOf(true, false), rows.map { it.visible })
    assertEquals(listOf(null, prototypeColor("#2255CC")), rows.map { it.style.background })
    assertEquals(
      listOf(
        PrototypeSetStateAction("picked", PrototypeScalar.Text("a")),
        PrototypeSetStateAction("label", PrototypeScalar.Text("row 0")),
        PrototypeSetStateAction("slot", PrototypeScalar.Numeric(0.0)),
        PrototypeEmitAction("pick_a"),
        PrototypeDismissAction,
      ),
      rows[0].source?.onTap,
    )
    assertEquals(
      PrototypeScalar.Numeric(7.0),
      (rows[1].source?.onTap?.first() as PrototypeSetStateAction).value,
    )
    assertEquals(PrototypeEmitAction("pick_7"), rows[1].source?.onTap?.get(3))
  }

  @Test
  fun `the container itself and non-template fields are not bound`() {
    val container =
      PrototypeColumnNode(
        children = listOf(PrototypeTextNode(text = "{item.label}")),
        repeat = PrototypeRepeat(items, "item"),
        visibleWhen = PrototypeCondition("k", equals = PrototypeScalar.Text("{item.id}")),
      )
    val model = mapPrototypeSpec(spec(container, mapOf("k" to PrototypeScalar.Text("{item.id}"))))
    assertTrue(model.root.visible)
    assertEquals(2, model.root.children.size)
  }

  @Test
  fun `expanded templates count against the node limit`() {
    val spacers = List(PrototypeSpecValidator.MAX_PROTOTYPE_NODES / 16) { PrototypeSpacerNode() }
    val many = List(32) { mapOf("n" to PrototypeScalar.Numeric(it.toDouble())) }
    // 32 instances of 31 spacers is 992 nodes, far over the limit, though the template is small.
    val error =
      assertThrows(IllegalArgumentException::class.java) {
        mapPrototypeSpec(spec(list(*spacers.toTypedArray(), repeat = many)))
      }
    assertTrue(error.message.orEmpty().contains("Node limit exceeded"))
  }

  @Test
  fun `placeholder grammar leaves other braces literal`() {
    fun fields(text: String) = PrototypeRepeatTemplate.fieldReferences(text, "item")
    assertEquals(
      listOf("a", "c"),
      fields("{index} {item.a} {x.b} {item} {item.} {{item.c}} {item.d"),
    )
    assertEquals(emptyList<String>(), fields("{items.a} {it.a} {item.${"a".repeat(65)}}"))
    assertEquals(
      listOf(
        PrototypeRepeatSegment.Literal("a "),
        PrototypeRepeatSegment.Index,
        PrototypeRepeatSegment.Literal(" "),
        PrototypeRepeatSegment.Field("f"),
        PrototypeRepeatSegment.Literal(" {state}"),
      ),
      PrototypeRepeatTemplate.segments("a {index} {item.f} {state}", "item"),
    )
  }

  @Test
  fun `integral values render without a decimal point or exponent at any magnitude`() {
    val big =
      listOf(
        mapOf(
          "a" to PrototypeScalar.Numeric(999_999_999_999_999.0),
          "b" to PrototypeScalar.Numeric(1e15),
          "c" to PrototypeScalar.Numeric(1e21),
          "d" to PrototypeScalar.Numeric(-2.5),
          "e" to PrototypeScalar.Numeric(-0.0),
          "f" to PrototypeScalar.Numeric(0.00001),
        ),
      )
    val model =
      mapPrototypeSpec(
        spec(
          list(
            PrototypeTextNode(
              text = "{item.a} {item.b} {item.c} {item.d} {item.e} {item.f}",
            ),
            repeat = big,
          ),
        ),
      )
    assertEquals(
      "999999999999999 1000000000000000 1000000000000000000000 -2.5 0 0.00001",
      model.root.children.single().text,
    )
  }

  @Test
  fun `component labels and button actions bind per item`() {
    val open = PrototypeSheetCondition("open", true)
    fun button(label: String, name: String) =
      PrototypeDialogButton(label, listOf(PrototypeEmitAction(name)))
    val template =
      listOf(
        PrototypeButtonNode(label = "Open {item.label}"),
        PrototypeFabNode(icon = "add", label = "New {index}"),
        PrototypeSegmentedButtonNode(
          stateKey = "mode",
          options =
            listOf(PrototypeRadioOption("a", "{item.label} A"), PrototypeRadioOption("b", "B")),
        ),
        PrototypeTopAppBarNode(
          title = "{item.label} ({item.price})",
          navigationIcon =
            PrototypeAppBarAction(
              "menu",
              "Back {item.label}",
              listOf(PrototypeEmitAction("b{index}")),
            ),
          actions = listOf(PrototypeAppBarAction("delete", "Del {item.label}")),
        ),
        PrototypeDialogNode(
          openWhen = open,
          title = "Remove {item.label}?",
          text = "{item.price} left",
          confirm = button("Remove {item.label}", "rm-{item.id}"),
          dismiss = PrototypeDialogButton("Keep {item.label}"),
        ),
        PrototypeSnackbarNode(
          openWhen = open,
          text = "Removed {item.label}",
          action = button("Undo {item.label}", "undo-{index}"),
        ),
      )
    val bound = prototypeChildEntries(list(*template.toTypedArray()), "root").map { it.node }
    val second = bound.drop(template.size)
    assertEquals("Open Beta", (second[0] as PrototypeButtonNode).label)
    assertEquals("New 1", (second[1] as PrototypeFabNode).label)
    val segmented = second[2] as PrototypeSegmentedButtonNode
    assertEquals(listOf("Beta A", "B"), segmented.options.map { it.label })
    assertEquals(listOf("a", "b"), segmented.options.map { it.value })
    val bar = second[3] as PrototypeTopAppBarNode
    assertEquals("Beta (4.5)", bar.title)
    assertEquals("Back Beta", bar.navigationIcon?.label)
    assertEquals(listOf(PrototypeEmitAction("b1")), bar.navigationIcon?.onTap)
    assertEquals("Del Beta", bar.actions?.single()?.label)
    val dialog = second[4] as PrototypeDialogNode
    assertEquals("Remove Beta?", dialog.title)
    assertEquals("4.5 left", dialog.text)
    assertEquals("Remove Beta", dialog.confirm.label)
    assertEquals(listOf(PrototypeEmitAction("rm-7")), dialog.confirm.onTap)
    assertEquals("Keep Beta", dialog.dismiss?.label)
    val snackbar = second[5] as PrototypeSnackbarNode
    assertEquals("Removed Beta", snackbar.text)
    assertEquals("Undo Beta", snackbar.action?.label)
    assertEquals(listOf(PrototypeEmitAction("undo-1")), snackbar.action?.onTap)
    assertEquals("Open Alpha", (bound[0] as PrototypeButtonNode).label)
  }

  @Test
  fun `an emit name that expands to empty for any item fails validation at the name`() {
    fun json(name: String) =
      """{"id":"r","window":{"placement":{"type":"fullscreen"}},"root":{"type":"column",""" +
        """"repeat":{"items":[{"id":"a"},{"id":""}],"as":"item"},"children":[{"type":"text",""" +
        """"text":"x","onTap":[{"type":"emit","name":"$name"}]}]}}"""
    val failure =
      PrototypeSpecValidator.validate(json("{item.id}")) as PrototypeSpecValidation.Failure
    assertEquals("root.children[0].onTap[0].name", failure.error.path)
    assertEquals("Expanded emit name is empty for item 1", failure.error.message)
    assertTrue(
      PrototypeSpecValidator.validate(json("row-{item.id}")) is PrototypeSpecValidation.Success,
    )
  }

  private fun fixture(name: String): PrototypeSpec {
    val file =
      generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
        .map { File(it, "test/fixtures/prototype-spec/valid/$name.json") }
        .first { it.isFile }
    val validated = PrototypeSpecValidator.validate(file.readText())
    return (validated as? PrototypeSpecValidation.Success)?.spec ?: error(validated.toString())
  }

  @Test
  fun `bound state keys toggle and style each row independently`() = runTest {
    val runtime = PrototypeRuntime(fixture("repeat-state-keys"), nextSequence = { 0L })
    fun rows() = mapPrototypeSpec(runtime.current.spec).root.children.map { it.children }
    fun liked() = rows().map { row -> row[2].visible }
    val likeKeys =
      rows().map { row ->
        ((row[1].source as PrototypeTextNode).onTap!!.single() as PrototypeToggleAction).key
      }
    assertEquals(listOf("liked_a", "liked_b"), likeKeys)
    assertEquals(listOf(false, true), liked())
    val switches = rows().map { row -> (row[3].source as PrototypeSwitchNode).stateKey }
    assertEquals(listOf("notify_a", "notify_b"), switches)
    val trailing = rows().map { row -> (row[5].source as PrototypeListItemNode).trailing }
    assertEquals(
      listOf(PrototypeListItemCheckbox("saved_a"), PrototypeListItemCheckbox("saved_b")),
      trailing,
    )
    val dialogs = rows().map { row -> (row[6].source as PrototypeDialogNode).openWhen.key }
    assertEquals(listOf("open_a", "open_b"), dialogs)

    fun likeColors() = rows().map { row -> row[1].style.color }
    val likedColor = likeColors()[1]
    assertNotEquals(likedColor, likeColors()[0])

    runtime.handle(PrototypeInteraction.Tap((rows()[0][1].source as PrototypeTextNode).onTap!!))
    assertEquals(listOf(true, true), liked())
    assertEquals(listOf(likedColor, likedColor), likeColors())
    runtime.handle(PrototypeInteraction.Tap((rows()[1][1].source as PrototypeTextNode).onTap!!))
    assertEquals(listOf(true, false), liked())
    assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["liked_a"])
    assertEquals(PrototypeScalar.BooleanValue(false), runtime.current.state["liked_b"])
    assertEquals(likedColor, likeColors()[0])
    assertNotEquals(likedColor, likeColors()[1])
  }
}
