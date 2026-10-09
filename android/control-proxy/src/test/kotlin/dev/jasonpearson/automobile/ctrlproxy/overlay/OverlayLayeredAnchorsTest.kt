package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Test

/** Which anchored nodes the window-level anchor layer draws (#10803). */
class OverlayLayeredAnchorsTest {
  private val bounds = OverlayBounds(10.0, 20.0, 30.0, 40.0)

  private fun anchored(tag: String, children: List<OverlayNode> = emptyList()) =
    OverlayBoxNode(testTag = tag, anchor = OverlayBoundsAnchor(bounds), children = children)

  private fun layered(root: OverlayNode, state: Map<String, OverlayScalar> = emptyMap()) =
    layeredOverlayAnchors(
        mapOverlaySpec(
            OverlaySpec(
              "a",
              OverlayWindow(OverlayFullscreenPlacement()),
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
      OverlayColumnNode(
        anchor = OverlayBoundsAnchor(bounds),
        children =
          listOf(
            OverlayRowNode(children = listOf(anchored("a", listOf(anchored("a.inner"))))),
            anchored("b"),
            OverlayTextNode(text = "plain"),
          ),
      )
    assertEquals(listOf("a", "a.inner", "b"), layered(root))
  }

  @Test
  fun `a hidden ancestor flags its anchored nodes so the layer can fade them with it`() {
    val hidden = OverlayCondition("show", OverlayScalar.BooleanValue(true))
    val root =
      OverlayBoxNode(
        children =
          listOf(
            OverlayBoxNode(visibleWhen = hidden, children = listOf(anchored("underHidden"))),
            OverlayBoxNode(
              testTag = "self",
              anchor = OverlayBoundsAnchor(bounds),
              visibleWhen = hidden,
              children = listOf(anchored("underSelf")),
            ),
          ),
      )
    val off = mapOf("show" to OverlayScalar.BooleanValue(false))
    assertEquals(listOf("underHidden", "self", "underSelf"), layered(root, off))
    assertEquals(listOf(false, true, false), shown(root, off))
    val on = mapOf("show" to OverlayScalar.BooleanValue(true))
    assertEquals(listOf("underHidden", "self", "underSelf"), layered(root, on))
    assertEquals(listOf(true, true, true), shown(root, on))
  }

  @Test
  fun `the anchored node follows the outermost hiding animated ancestor, else the nearest`() {
    val outer = OverlayCondition("outer", OverlayScalar.BooleanValue(true))
    val inner = OverlayCondition("inner", OverlayScalar.BooleanValue(true))
    val root =
      OverlayBoxNode(
        children =
          listOf(
            OverlayBoxNode(
              testTag = "outer",
              visibleWhen = outer,
              children =
                listOf(
                  OverlayBoxNode(
                    testTag = "inner",
                    visibleWhen = inner,
                    children = listOf(OverlayBoxNode(children = listOf(anchored("leaf")))),
                  ),
                ),
            ),
          ),
      )
    fun follows(state: Map<String, OverlayScalar>) =
      layeredOverlayAnchors(
          mapOverlaySpec(
              OverlaySpec("a", OverlayWindow(OverlayFullscreenPlacement()), state, root),
            )
            .root,
        )
        .single()
        .animatedAncestor
        ?.testTag
    val yes = OverlayScalar.BooleanValue(true)
    val no = OverlayScalar.BooleanValue(false)
    assertEquals("inner", follows(mapOf("outer" to yes, "inner" to yes)))
    assertEquals("inner", follows(mapOf("outer" to yes, "inner" to no)))
    assertEquals("outer", follows(mapOf("outer" to no, "inner" to no)))
    assertEquals("outer", follows(mapOf("outer" to no, "inner" to yes)))
  }

  private fun shown(root: OverlayNode, state: Map<String, OverlayScalar>) =
    layeredOverlayAnchors(
        mapOverlaySpec(
            OverlaySpec(
              "a",
              OverlayWindow(OverlayFullscreenPlacement()),
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
      OverlayBoxNode(
        children =
          listOf(
            OverlayPagerNode(id = "p", children = listOf(anchored("page0"), anchored("page1"))),
            OverlayBottomSheetNode(
              child = anchored("inSheet"),
              openWhen = OverlaySheetCondition("open", true),
              detents = listOf(OverlayDetent.Full),
            ),
          ),
      )
    val open = mapOf("open" to OverlayScalar.BooleanValue(true))
    assertEquals(listOf("page0"), layered(root, open))
    // An open sheet draws its own anchor layer above itself.
    val spec = OverlaySpec("a", OverlayWindow(OverlayFullscreenPlacement()), open, root)
    val sheet = modalOverlaySheets(mapOverlaySpec(spec).root).single()
    assertEquals(listOf("inSheet"), layeredOverlayAnchorsIn(sheet.children).map { it.node.testTag })
  }
}
