package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Test

/** Which anchored nodes the window-level anchor layer draws (#10803). */
class PrototypeLayeredAnchorsTest {
  private val bounds = PrototypeBounds(10.0, 20.0, 30.0, 40.0)

  private fun anchored(tag: String, children: List<PrototypeNode> = emptyList()) =
    PrototypeBoxNode(testTag = tag, anchor = PrototypeBoundsAnchor(bounds), children = children)

  private fun layered(root: PrototypeNode, state: Map<String, PrototypeScalar> = emptyMap()) =
    layeredPrototypeAnchors(
        mapPrototypeSpec(
            PrototypeSpec(
              "a",
              PrototypeWindow(PrototypeFullscreenPlacement()),
              state = state,
              root = root,
            ),
          )
          .root,
      )
      .map { it.node.testTag }

  @Test
  fun `anchored descendants are listed in tree order, nested ones too, but never the root`() {
    val root =
      PrototypeColumnNode(
        anchor = PrototypeBoundsAnchor(bounds),
        children =
          listOf(
            PrototypeRowNode(children = listOf(anchored("a", listOf(anchored("a.inner"))))),
            anchored("b"),
            PrototypeTextNode(text = "plain"),
          ),
      )
    assertEquals(listOf("a", "a.inner", "b"), layered(root))
  }

  @Test
  fun `a hidden ancestor flags its anchored nodes so the layer can fade them with it`() {
    val hidden = PrototypeCondition("show", PrototypeScalar.BooleanValue(true))
    val root =
      PrototypeBoxNode(
        children =
          listOf(
            PrototypeBoxNode(visibleWhen = hidden, children = listOf(anchored("underHidden"))),
            PrototypeBoxNode(
              testTag = "self",
              anchor = PrototypeBoundsAnchor(bounds),
              visibleWhen = hidden,
              children = listOf(anchored("underSelf")),
            ),
          ),
      )
    val off = mapOf("show" to PrototypeScalar.BooleanValue(false))
    assertEquals(listOf("underHidden", "self", "underSelf"), layered(root, off))
    assertEquals(listOf(false, true, false), shown(root, off))
    val on = mapOf("show" to PrototypeScalar.BooleanValue(true))
    assertEquals(listOf("underHidden", "self", "underSelf"), layered(root, on))
    assertEquals(listOf(true, true, true), shown(root, on))
  }

  @Test
  fun `the anchored node follows the outermost hiding animated ancestor, else the nearest`() {
    val outer = PrototypeCondition("outer", PrototypeScalar.BooleanValue(true))
    val inner = PrototypeCondition("inner", PrototypeScalar.BooleanValue(true))
    val root =
      PrototypeBoxNode(
        children =
          listOf(
            PrototypeBoxNode(
              testTag = "outer",
              visibleWhen = outer,
              children =
                listOf(
                  PrototypeBoxNode(
                    testTag = "inner",
                    visibleWhen = inner,
                    children = listOf(PrototypeBoxNode(children = listOf(anchored("leaf")))),
                  ),
                ),
            ),
          ),
      )
    fun follows(state: Map<String, PrototypeScalar>) =
      layeredPrototypeAnchors(
          mapPrototypeSpec(
              PrototypeSpec("a", PrototypeWindow(PrototypeFullscreenPlacement()), state, root),
            )
            .root,
        )
        .single()
        .animatedAncestor
        ?.testTag
    val yes = PrototypeScalar.BooleanValue(true)
    val no = PrototypeScalar.BooleanValue(false)
    assertEquals("inner", follows(mapOf("outer" to yes, "inner" to yes)))
    assertEquals("inner", follows(mapOf("outer" to yes, "inner" to no)))
    assertEquals("outer", follows(mapOf("outer" to no, "inner" to no)))
    assertEquals("outer", follows(mapOf("outer" to no, "inner" to yes)))
  }

  private fun shown(root: PrototypeNode, state: Map<String, PrototypeScalar>) =
    layeredPrototypeAnchors(
        mapPrototypeSpec(
            PrototypeSpec(
              "a",
              PrototypeWindow(PrototypeFullscreenPlacement()),
              state = state,
              root = root,
            ),
          )
          .root,
      )
      .map { it.ancestorsShown }

  @Test
  fun `only the settled pager page and no modal content is listed`() {
    val root =
      PrototypeBoxNode(
        children =
          listOf(
            PrototypePagerNode(id = "p", children = listOf(anchored("page0"), anchored("page1"))),
            PrototypeBottomSheetNode(
              child = anchored("inSheet"),
              openWhen = PrototypeSheetCondition("open", true),
              detents = listOf(PrototypeDetent.Full),
            ),
          ),
      )
    val open = mapOf("open" to PrototypeScalar.BooleanValue(true))
    assertEquals(listOf("page0"), layered(root, open))
    // An open sheet draws its own anchor layer above itself.
    val spec = PrototypeSpec("a", PrototypeWindow(PrototypeFullscreenPlacement()), open, root)
    val sheet = modalPrototypeSheets(mapPrototypeSpec(spec).root).single()
    assertEquals(
      listOf("inSheet"),
      layeredPrototypeAnchorsIn(sheet.children).map { it.node.testTag },
    )
  }
}
