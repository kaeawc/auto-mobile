package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeSemanticsTest {
  @Test
  fun `authored text is the label`() {
    assertEquals("Save", prototypeContentDescription("text", "Save", null, tappable = false))
    assertEquals("Save", prototypeContentDescription("box", "Save", null, tappable = true))
  }

  @Test
  fun `an icon-only tappable node reads as its icon name`() {
    assertEquals("add", prototypeContentDescription("icon", "", "add", tappable = true))
  }

  @Test
  fun `layout containers without text or actions have no label`() {
    for (role in listOf("box", "row", "column", "scroll", "pager", "spacer")) {
      assertNull(role, prototypeContentDescription(role, "", null, tappable = false))
    }
  }

  @Test
  fun `a tappable container whose only content is an icon reads as the icon`() {
    val icon = node("icon", text = "add", iconName = "add")
    assertEquals("add", prototypeContentDescription("box", "", null, true, listOf(icon)))
    assertEquals(
      "add",
      prototypeContentDescription(
        "row",
        "",
        null,
        true,
        listOf(node("box", children = listOf(icon))),
      ),
    )
  }

  @Test
  fun `a tappable container with other content is not labelled by its kind`() {
    val icon = node("icon", text = "add", iconName = "add")
    val text = node("text", text = "Add")
    assertNull(prototypeContentDescription("row", "", null, true, listOf(icon, text)))
    assertNull(prototypeContentDescription("box", "", null, true, listOf(text)))
    assertNull(
      prototypeContentDescription("box", "", null, true, listOf(icon.copy(visible = false), text)),
    )
  }

  @Test
  fun `a childless tappable container and non-container kinds keep their kind`() {
    assertEquals("box", prototypeContentDescription("box", "", null, tappable = true))
    assertEquals("icon", prototypeContentDescription("icon", "", null, tappable = false))
  }

  @Test
  fun `navigation bars are labelled by their tabs, not their kind`() {
    assertNull(prototypeContentDescription("tabBar", "", null, tappable = false))
    assertNull(prototypeContentDescription("bottomNav", "", null, tappable = false))
  }

  @Test
  fun `an authored content description wins over text, icon and kind`() {
    assertEquals(
      "Close",
      prototypeContentDescription("icon", "close", "close", true, authored = "Close"),
    )
    assertEquals("Promo", prototypeContentDescription("box", "", null, false, authored = "Promo"))
    assertEquals(
      "Next",
      prototypeContentDescription("button", "Go", null, false, authored = "Next"),
    )
  }

  @Test
  fun `only a layout container with nothing to report is semantics free`() {
    val box = node("box")
    assertTrue(isSemanticsFreeContainer(box, tappable = false, description = null, state = null))
    assertFalse(isSemanticsFreeContainer(box, tappable = true, description = null, state = null))
    assertFalse(isSemanticsFreeContainer(box, false, description = "Promo", state = null))
    assertFalse(isSemanticsFreeContainer(node("pager"), false, null, state = "Page 1 of 2"))
    assertFalse(isSemanticsFreeContainer(box.copy(testTag = "promo"), false, null, null))
    assertFalse(isSemanticsFreeContainer(node("text"), false, null, null))
  }

  @Test
  fun `a pager reports its page`() {
    assertEquals("Page 2 of 4", prototypeStateDescription("pager", 1, 4))
    assertNull(prototypeStateDescription("pager", 0, 0))
    assertNull(prototypeStateDescription("row", 1, 4))
  }

  private fun node(
    role: String,
    text: String = "",
    iconName: String? = null,
    children: List<PrototypeRenderNode> = emptyList(),
  ) =
    PrototypeRenderNode(
      role = role,
      text = text,
      testTag = null,
      visible = true,
      style = mapPrototypeStyle(PrototypeStyle()),
      safeArea = null,
      iconName = iconName,
      children = children,
    )
}
