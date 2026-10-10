package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/**
 * The window may take focus only while a text field is on screen NOW. Presence in the spec is not
 * enough: a field on another pager page, in a closed sheet or under a false `visibleWhen` is not
 * shown, so it must not hold focus or swallow Back.
 */
class OverlayTextFieldVisibilityTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      OverlaySpecValidator.validate("{}")
    }
  }

  private val field = OverlayTextFieldNode(stateKey = "query")

  private fun visible(
    root: OverlayNode,
    state: Map<String, OverlayScalar> = emptyMap(),
    pages: Map<String, Int> = emptyMap(),
  ) =
    mapOverlaySpec(
        OverlaySpec("panel", OverlayWindow(OverlayFullscreenPlacement()), state, root),
        pages,
      )
      .hasTextField

  @Test
  fun `a plain visible field and a field nested in containers count`() {
    assertTrue(visible(field))
    assertTrue(visible(OverlayColumnNode(children = listOf(OverlayScrollNode(child = field)))))
  }

  @Test
  fun `no field and a field hidden by visibleWhen do not count`() {
    assertFalse(visible(OverlayTextNode(text = "x")))
    val hidden =
      field.copy(visibleWhen = OverlayCondition("show", OverlayScalar.BooleanValue(true)))
    assertFalse(visible(hidden, mapOf("show" to OverlayScalar.BooleanValue(false))))
    assertTrue(visible(hidden, mapOf("show" to OverlayScalar.BooleanValue(true))))
    val hiddenParent =
      OverlayBoxNode(
        visibleWhen = OverlayCondition("show", OverlayScalar.BooleanValue(true)),
        children = listOf(field),
      )
    assertFalse(visible(hiddenParent, mapOf("show" to OverlayScalar.BooleanValue(false))))
  }

  @Test
  fun `a field on another pager page counts only once that page is current`() {
    val pager = OverlayPagerNode("pager", children = listOf(OverlayTextNode(text = "one"), field))
    assertFalse(visible(pager))
    assertFalse(visible(pager, pages = mapOf("pager" to 0)))
    assertTrue(visible(pager, pages = mapOf("pager" to 1)))
  }

  private fun sheet(child: OverlayNode) =
    OverlayBottomSheetNode(
      child = child,
      openWhen = OverlaySheetCondition("open", true),
      detents = listOf(OverlayDetent.Full),
    )

  @Test
  fun `a field in a closed bottom sheet does not count and counts while the sheet is open`() {
    val root = OverlayBoxNode(children = listOf(OverlayTextNode(text = "page"), sheet(field)))
    assertFalse(visible(root, mapOf("open" to OverlayScalar.BooleanValue(false))))
    assertTrue(visible(root, mapOf("open" to OverlayScalar.BooleanValue(true))))
  }

  @Test
  fun `an open sheet on a non-current pager page or under a hidden parent does not count`() {
    val open = mapOf("open" to OverlayScalar.BooleanValue(true))
    val pager =
      OverlayPagerNode("pager", children = listOf(OverlayTextNode(text = "one"), sheet(field)))
    assertFalse(visible(pager, open, mapOf("pager" to 0)))
    assertTrue(visible(pager, open, mapOf("pager" to 1)))
    val hidden =
      OverlayBoxNode(
        visibleWhen = OverlayCondition("show", OverlayScalar.BooleanValue(true)),
        children = listOf(sheet(field)),
      )
    assertFalse(visible(hidden, open + ("show" to OverlayScalar.BooleanValue(false))))
  }
}
