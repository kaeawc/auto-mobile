package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
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
    assertNull(prototypeContentDescription("icon", "", null, tappable = false))
    assertEquals("icon", prototypeContentDescription("icon", "", null, tappable = true))
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

  @Test
  fun `only non-tappable visual kinds lose the kind fallback`() {
    for (kind in listOf("text", "icon", "image")) {
      assertNull(kind, prototypeContentDescription(kind, "", null, false))
      assertEquals(kind, prototypeContentDescription(kind, "", null, true))
      assertEquals("Authored", prototypeContentDescription(kind, "Authored", null, false))
      assertEquals(
        "Description",
        prototypeContentDescription(kind, "", null, false, authored = "Description"),
      )
    }
    for (kind in
      listOf(
        "switch",
        "progress",
        "badge",
        "textField",
        "checkbox",
        "slider",
        "chip",
        "radioGroup",
        "listItem",
        "segmentedButton",
        "topAppBar",
        "dialog",
        "snackbar",
        "bottomSheet",
        "timePicker",
        "datePicker",
      )) {
      assertEquals(kind, prototypeContentDescription(kind, "", null, false))
    }
    for (kind in listOf("iconButton", "fab")) {
      assertEquals("add", prototypeContentDescription(kind, "", "add", false))
    }
  }

  @Test
  fun `decorative visuals ignore icon names but preserve independent handles`() {
    for (kind in listOf("icon", "image")) {
      val visual = node(kind, text = "add", iconName = "add")
      assertTrue(isDecorativePrototypeVisual(visual, false))
      assertTrue(isDecorativePrototypeVisual(visual.copy(contentDescription = ""), false))
      assertFalse(isDecorativePrototypeVisual(visual, true))
      assertFalse(isDecorativePrototypeVisual(visual.copy(testTag = "target"), false))
      assertFalse(isDecorativePrototypeVisual(visual.copy(contentDescription = "Target"), false))
    }
    assertFalse(isDecorativePrototypeVisual(node("text"), false))
  }

  @Test
  fun `one plain text can label a tappable container through nested layouts`() {
    val text = node("text", text = "General")
    for (kind in listOf("box", "row", "column", "card")) {
      val container = node(kind, children = listOf(text))
      assertEquals("General", prototypeMergedTapLabel(container, true))
      assertNull(prototypeMergedTapLabel(container, false))
      assertNull(prototypeMergedTapLabel(container.copy(text = "Authored"), true))
      assertNull(prototypeMergedTapLabel(container.copy(contentDescription = "Authored"), true))
    }
    val row =
      node(
        "row",
        children =
          listOf(
            node("icon", "settings"),
            node("image"),
            node("divider"),
            node("spacer"),
            node("box", children = listOf(node("card", children = listOf(text)))),
          ),
      )
    assertEquals("General", prototypeMergedTapLabel(row, true))
    assertEquals(
      "General",
      prototypeMergedTapLabel(row.copy(children = listOf(text.copy(visible = false))), true),
    )
    assertNull(prototypeMergedTapLabel(row.copy(role = "scroll"), true))
    assertNull(prototypeMergedTapLabel(row.copy(children = listOf(node("icon", "add"))), true))
  }

  @Test
  fun `merging rejects any independently targetable or stateful descendant`() {
    val text = node("text", text = "General")
    val condition = PrototypeCondition("show", PrototypeScalar.BooleanValue(true))
    val action = listOf<PrototypeAction>(PrototypeEmitAction("open"))
    val rejected =
      listOf(
        text,
        node("text"),
        text.copy(testTag = "target"),
        text.copy(contentDescription = "Target"),
        text.copy(source = PrototypeTextNode(text = "General", visibleWhen = condition)),
        text.copy(source = PrototypeTextNode(text = "General", onTap = action)),
        node("icon").copy(testTag = "icon"),
        node("image").copy(contentDescription = "Image"),
        node("icon").copy(source = PrototypeIconNode(name = "add", onTap = action)),
        node("box").copy(testTag = "box"),
        node("row").copy(text = "Own text"),
        node("column")
          .copy(
            source = PrototypeColumnNode(children = emptyList(), visibleWhen = condition),
          ),
      ) +
        listOf("switch", "button", "scroll", "pager", "textField", "dialog", "tabBar", "chip").map {
          node(it)
        }
    for (child in rejected) {
      assertNull(
        child.toString(),
        prototypeMergedTapLabel(node("row", children = listOf(text, child)), true),
      )
    }
  }

  @Test
  fun `merging rejects anchored descendants drawn outside the container`() {
    val text = node("text", text = "General")
    val anchored =
      text.copy(
        source =
          PrototypeTextNode(
            text = "General",
            anchor = PrototypeBoundsAnchor(PrototypeBounds(10.0, 20.0, 100.0, 40.0)),
          ),
      )
    assertNull(prototypeMergedTapLabel(node("row", children = listOf(anchored)), true))
    assertNull(
      prototypeMergedTapLabel(
        node("row", children = listOf(node("box", children = listOf(anchored)))),
        true,
      ),
    )
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
