package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/**
 * The window may take focus only while a text field is on screen NOW. Presence in the spec is not
 * enough: a field on another pager page, in a closed sheet or under a false `visibleWhen` is not
 * shown, so it must not hold focus or swallow Back.
 */
class PrototypeTextFieldVisibilityTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val field = PrototypeTextFieldNode(stateKey = "query")

  private fun visible(
    root: PrototypeNode,
    state: Map<String, PrototypeScalar> = emptyMap(),
    pages: Map<String, Int> = emptyMap(),
  ) =
    mapPrototypeSpec(
        PrototypeSpec("panel", PrototypeWindow(PrototypeFullscreenPlacement()), state, root),
        pages,
      )
      .hasTextField

  @Test
  fun `a plain visible field and a field nested in containers count`() {
    assertTrue(visible(field))
    assertTrue(visible(PrototypeColumnNode(children = listOf(PrototypeScrollNode(child = field)))))
  }

  @Test
  fun `no field and a field hidden by visibleWhen do not count`() {
    assertFalse(visible(PrototypeTextNode(text = "x")))
    val hidden =
      field.copy(visibleWhen = PrototypeCondition("show", PrototypeScalar.BooleanValue(true)))
    assertFalse(visible(hidden, mapOf("show" to PrototypeScalar.BooleanValue(false))))
    assertTrue(visible(hidden, mapOf("show" to PrototypeScalar.BooleanValue(true))))
    val hiddenParent =
      PrototypeBoxNode(
        visibleWhen = PrototypeCondition("show", PrototypeScalar.BooleanValue(true)),
        children = listOf(field),
      )
    assertFalse(visible(hiddenParent, mapOf("show" to PrototypeScalar.BooleanValue(false))))
  }

  @Test
  fun `a field on another pager page counts only once that page is current`() {
    val pager =
      PrototypePagerNode("pager", children = listOf(PrototypeTextNode(text = "one"), field))
    assertFalse(visible(pager))
    assertFalse(visible(pager, pages = mapOf("pager" to 0)))
    assertTrue(visible(pager, pages = mapOf("pager" to 1)))
  }

  private fun sheet(child: PrototypeNode) =
    PrototypeBottomSheetNode(
      child = child,
      openWhen = PrototypeSheetCondition("open", true),
      detents = listOf(PrototypeDetent.Full),
    )

  @Test
  fun `a field in a closed bottom sheet does not count and counts while the sheet is open`() {
    val root = PrototypeBoxNode(children = listOf(PrototypeTextNode(text = "page"), sheet(field)))
    assertFalse(visible(root, mapOf("open" to PrototypeScalar.BooleanValue(false))))
    assertTrue(visible(root, mapOf("open" to PrototypeScalar.BooleanValue(true))))
  }

  @Test
  fun `an open sheet on a non-current pager page or under a hidden parent does not count`() {
    val open = mapOf("open" to PrototypeScalar.BooleanValue(true))
    val pager =
      PrototypePagerNode("pager", children = listOf(PrototypeTextNode(text = "one"), sheet(field)))
    assertFalse(visible(pager, open, mapOf("pager" to 0)))
    assertTrue(visible(pager, open, mapOf("pager" to 1)))
    val hidden =
      PrototypeBoxNode(
        visibleWhen = PrototypeCondition("show", PrototypeScalar.BooleanValue(true)),
        children = listOf(sheet(field)),
      )
    assertFalse(visible(hidden, open + ("show" to PrototypeScalar.BooleanValue(false))))
  }
}
