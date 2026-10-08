package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Test

class OverlayRepeatTest {
  private val items =
    listOf(
      mapOf(
        "id" to OverlayScalar.Text("a"),
        "label" to OverlayScalar.Text("Alpha"),
        "price" to OverlayScalar.Numeric(3.0),
        "on" to OverlayScalar.BooleanValue(true),
      ),
      mapOf(
        "id" to OverlayScalar.Numeric(7.0),
        "label" to OverlayScalar.Text("Beta"),
        "price" to OverlayScalar.Numeric(4.5),
        "on" to OverlayScalar.BooleanValue(false),
      ),
    )

  private fun spec(root: OverlayNode, state: Map<String, OverlayScalar>? = null) =
    OverlaySpec("panel", OverlayWindow(OverlayFullscreenPlacement()), state, root)

  private fun list(vararg template: OverlayNode, repeat: List<Map<String, OverlayScalar>> = items) =
    OverlayColumnNode(
      children = template.toList(),
      repeat = OverlayRepeat(repeat, "item"),
    )

  @Test
  fun `children are instantiated per item with text bound and stable per index identities`() {
    val model =
      mapOverlaySpec(
        spec(
          list(
            OverlayTextNode(
              text = "{index}: {item.label} costs {item.price} ({item.on}) {other.x}",
            ),
            OverlayRowNode(children = listOf(OverlayTextNode(text = "{item.label}!"))),
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
      OverlayTextNode(
        text = "row",
        visibleWhen = OverlayCondition("picked", notEquals = OverlayScalar.Text("{item.id}")),
        styleWhen =
          listOf(
            OverlayStyleWhen(
              OverlayCondition(
                all =
                  listOf(
                    OverlayCondition("picked", equals = OverlayScalar.Text("{item.id}")),
                    OverlayCondition(
                      not = OverlayCondition("slot", equals = OverlayScalar.Text("{index}")),
                    ),
                  ),
              ),
              OverlayStyle(background = "#2255CC"),
            ),
          ),
        onTap =
          listOf(
            OverlaySetStateAction("picked", OverlayScalar.Text("{item.id}")),
            OverlaySetStateAction("label", OverlayScalar.Text("row {index}")),
            OverlaySetStateAction("slot", OverlayScalar.Text("{index}")),
            OverlayEmitAction("pick_{item.id}"),
            OverlayDismissAction,
          ),
      )
    val state = mapOf("picked" to OverlayScalar.Numeric(7.0), "slot" to OverlayScalar.Numeric(9.0))
    val rows = mapOverlaySpec(spec(list(node), state)).root.children
    // Item 0 has the text id "a" (not picked); item 1 has the numeric id 7, matching typed state.
    assertEquals(listOf(true, false), rows.map { it.visible })
    assertEquals(listOf(null, overlayColor("#2255CC")), rows.map { it.style.background })
    assertEquals(
      listOf(
        OverlaySetStateAction("picked", OverlayScalar.Text("a")),
        OverlaySetStateAction("label", OverlayScalar.Text("row 0")),
        OverlaySetStateAction("slot", OverlayScalar.Numeric(0.0)),
        OverlayEmitAction("pick_a"),
        OverlayDismissAction,
      ),
      rows[0].source?.onTap,
    )
    assertEquals(
      OverlayScalar.Numeric(7.0),
      (rows[1].source?.onTap?.first() as OverlaySetStateAction).value,
    )
    assertEquals(OverlayEmitAction("pick_7"), rows[1].source?.onTap?.get(3))
  }

  @Test
  fun `the container itself and non-template fields are not bound`() {
    val container =
      OverlayColumnNode(
        children = listOf(OverlayTextNode(text = "{item.label}")),
        repeat = OverlayRepeat(items, "item"),
        visibleWhen = OverlayCondition("k", equals = OverlayScalar.Text("{item.id}")),
      )
    val model = mapOverlaySpec(spec(container, mapOf("k" to OverlayScalar.Text("{item.id}"))))
    assertTrue(model.root.visible)
    assertEquals(2, model.root.children.size)
  }

  @Test
  fun `expanded templates count against the node limit`() {
    val spacers = List(OverlaySpecValidator.MAX_OVERLAY_NODES / 16) { OverlaySpacerNode() }
    val many = List(32) { mapOf("n" to OverlayScalar.Numeric(it.toDouble())) }
    // 32 instances of 31 spacers is 992 nodes, far over the limit, though the template is small.
    val error =
      assertThrows(IllegalArgumentException::class.java) {
        mapOverlaySpec(spec(list(*spacers.toTypedArray(), repeat = many)))
      }
    assertTrue(error.message.orEmpty().contains("Node limit exceeded"))
  }

  @Test
  fun `placeholder grammar leaves other braces literal`() {
    fun fields(text: String) = OverlayRepeatTemplate.fieldReferences(text, "item")
    assertEquals(
      listOf("a", "c"),
      fields("{index} {item.a} {x.b} {item} {item.} {{item.c}} {item.d"),
    )
    assertEquals(emptyList<String>(), fields("{items.a} {it.a} {item.${"a".repeat(65)}}"))
    assertEquals(
      listOf(
        OverlayRepeatSegment.Literal("a "),
        OverlayRepeatSegment.Index,
        OverlayRepeatSegment.Literal(" "),
        OverlayRepeatSegment.Field("f"),
        OverlayRepeatSegment.Literal(" {state}"),
      ),
      OverlayRepeatTemplate.segments("a {index} {item.f} {state}", "item"),
    )
  }

  @Test
  fun `integral values render without a decimal point or exponent at any magnitude`() {
    val big =
      listOf(
        mapOf(
          "a" to OverlayScalar.Numeric(999_999_999_999_999.0),
          "b" to OverlayScalar.Numeric(1e15),
          "c" to OverlayScalar.Numeric(1e21),
          "d" to OverlayScalar.Numeric(-2.5),
        ),
      )
    val model =
      mapOverlaySpec(
        spec(list(OverlayTextNode(text = "{item.a} {item.b} {item.c} {item.d}"), repeat = big)),
      )
    assertEquals(
      "999999999999999 1000000000000000 1000000000000000000000 -2.5",
      model.root.children.single().text,
    )
  }

  @Test
  fun `an emit name that expands to empty for any item fails validation at the name`() {
    fun json(name: String) =
      """{"id":"r","window":{"placement":{"type":"fullscreen"}},"root":{"type":"column",""" +
        """"repeat":{"items":[{"id":"a"},{"id":""}],"as":"item"},"children":[{"type":"text",""" +
        """"text":"x","onTap":[{"type":"emit","name":"$name"}]}]}}"""
    val failure = OverlaySpecValidator.validate(json("{item.id}")) as OverlaySpecValidation.Failure
    assertEquals("root.children[0].onTap[0].name", failure.error.path)
    assertEquals("Expanded emit name is empty for item 1", failure.error.message)
    assertTrue(
      OverlaySpecValidator.validate(json("row-{item.id}")) is OverlaySpecValidation.Success,
    )
  }
}
