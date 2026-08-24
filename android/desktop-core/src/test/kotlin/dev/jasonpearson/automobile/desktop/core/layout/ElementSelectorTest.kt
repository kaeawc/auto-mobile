package dev.jasonpearson.automobile.desktop.core.layout

import dev.jasonpearson.automobile.desktop.core.clipboard.FakeClipboardWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ElementSelectorTest {

  private fun element(
    id: String = "e",
    className: String = "android.widget.Button",
    resourceId: String? = null,
    text: String? = null,
    contentDescription: String? = null,
  ): UIElementInfo =
    UIElementInfo(
      id = id,
      className = className,
      resourceId = resourceId,
      text = text,
      contentDescription = contentDescription,
      bounds = ElementBounds(0, 0, 10, 10),
      isClickable = true,
      isEnabled = true,
      isFocused = false,
      isSelected = false,
      isScrollable = false,
      isCheckable = false,
      isChecked = false,
      children = emptyList(),
      depth = 0,
    )

  @Test
  fun `resource-id wins over text and content-desc`() {
    val selector =
      buildElementSelector(
        element(
          className = "android.widget.Button",
          resourceId = "com.app:id/submit",
          text = "Submit",
          contentDescription = "Submit button",
        )
      )
    assertEquals("//Button[@resource-id='com.app:id/submit']", selector)
  }

  @Test
  fun `text wins when resource-id is absent`() {
    val selector =
      buildElementSelector(element(text = "Submit", contentDescription = "Submit button"))
    assertEquals("//Button[@text='Submit']", selector)
  }

  @Test
  fun `content-desc used when resource-id and text are absent`() {
    val selector = buildElementSelector(element(contentDescription = "Submit button"))
    assertEquals("//Button[@content-desc='Submit button']", selector)
  }

  @Test
  fun `class-only selector when nothing else identifies the element`() {
    val selector = buildElementSelector(element(className = "android.view.View"))
    assertEquals("//View", selector)
  }

  @Test
  fun `selector resolves back to the same element among siblings`() {
    val target = element(id = "target", resourceId = "com.app:id/ok", text = "OK")
    val pool =
      listOf(
        element(id = "other1", resourceId = "com.app:id/cancel", text = "Cancel"),
        target,
        element(id = "other2", text = "OK"), // same text, different (no) resource-id
      )

    val selector = buildElementSelector(target)
    val resolved = pool.filter { matchesSelector(it, selector) }

    assertEquals("selector must resolve to exactly one element", 1, resolved.size)
    assertEquals(target.id, resolved.single().id)
  }

  @Test
  fun `copyElementSelector writes the selector through the injected clipboard`() {
    val target = element(resourceId = "com.app:id/ok")
    val clipboard = FakeClipboardWriter()

    clipboard.copyElementSelector(target)

    assertEquals(buildElementSelector(target), clipboard.lastText)
  }

  /**
   * Minimal reverse-matcher used only to prove a generated selector uniquely re-identifies its
   * source element. Parses `//Simple[@attr='value']` (or bare `//Simple`) and checks the element.
   */
  private fun matchesSelector(element: UIElementInfo, selector: String): Boolean {
    val simpleName = element.className.substringAfterLast(".")
    val attrMatch = Regex("^//(\\w+)\\[@([\\w-]+)='(.*)']$").find(selector)
    if (attrMatch != null) {
      val (cls, attr, value) = attrMatch.destructured
      if (cls != simpleName) return false
      return when (attr) {
        "resource-id" -> element.resourceId == value
        "text" -> element.text == value
        "content-desc" -> element.contentDescription == value
        else -> false
      }
    }
    val classOnly = Regex("^//(\\w+)$").find(selector) ?: return false
    return classOnly.groupValues[1] == simpleName
  }

  @Test
  fun `reverse-matcher sanity check`() {
    // Guards the test's own resolver so the resolves-back assertion cannot pass vacuously.
    assertTrue(matchesSelector(element(resourceId = "x"), "//Button[@resource-id='x']"))
    assertTrue(!matchesSelector(element(resourceId = "x"), "//Button[@resource-id='y']"))
  }
}
