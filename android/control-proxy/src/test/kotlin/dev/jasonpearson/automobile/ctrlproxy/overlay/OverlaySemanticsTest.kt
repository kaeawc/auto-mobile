package dev.jasonpearson.automobile.ctrlproxy.overlay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OverlaySemanticsTest {
  @Test
  fun `authored text is the label`() {
    assertEquals("Save", overlayContentDescription("text", "Save", null, tappable = false))
    assertEquals("Save", overlayContentDescription("box", "Save", null, tappable = true))
  }

  @Test
  fun `an icon-only tappable node reads as its icon name`() {
    assertEquals("add", overlayContentDescription("icon", "", "add", tappable = true))
  }

  @Test
  fun `layout containers without text or actions have no label`() {
    for (role in listOf("box", "row", "column", "scroll", "pager", "spacer")) {
      assertNull(role, overlayContentDescription(role, "", null, tappable = false))
    }
  }

  @Test
  fun `a tappable container and non-container kinds keep their kind`() {
    assertEquals("box", overlayContentDescription("box", "", null, tappable = true))
    assertEquals("icon", overlayContentDescription("icon", "", null, tappable = false))
    assertEquals("tabBar", overlayContentDescription("tabBar", "", null, tappable = false))
  }

  @Test
  fun `a pager reports its page`() {
    assertEquals("Page 2 of 4", overlayStateDescription("pager", 1, 4))
    assertNull(overlayStateDescription("pager", 0, 0))
    assertNull(overlayStateDescription("row", 1, 4))
  }
}
