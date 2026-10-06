package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.CtrlProxy.ImeActionStep
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ImeActionStepTest {
  private val actions = listOf("done", "go", "send", "search", "next", "previous")

  @Test
  fun `missing editable focus rejects every action before dispatch`() {
    for (sdkInt in listOf(29, 30)) {
      for (action in actions) {
        val step = ImeActionStep.select(action, hasFocusedEditable = false, sdkInt = sdkInt)
        assertEquals("$action on API $sdkInt", ImeActionStep.NO_FOCUSED_EDITABLE, step)
        assertEquals("No focused editable node found for IME action", step.error)
      }
    }
  }

  @Test
  fun `focused editable fields preserve the existing action and API choices`() {
    for (sdkInt in listOf(29, 30)) {
      for (action in actions) {
        val expected =
          when (action) {
            "next" -> ImeActionStep.NEXT
            "previous" -> ImeActionStep.PREVIOUS
            else -> if (sdkInt >= 30) ImeActionStep.IME_ENTER else ImeActionStep.KEYCODE_ENTER
          }
        val step = ImeActionStep.select(action, hasFocusedEditable = true, sdkInt = sdkInt)
        assertEquals("$action on API $sdkInt", expected, step)
        assertNull(step.error)
      }
    }
  }

  @Test
  fun `a focused noneditable node is rejected just like absent focus`() {
    val isFocused = true
    val isEditable = false
    for (action in actions) {
      val step =
        ImeActionStep.select(action, hasFocusedEditable = isFocused && isEditable, sdkInt = 30)
      assertEquals(ImeActionStep.NO_FOCUSED_EDITABLE, step)
      assertEquals("No focused editable node found for IME action", step.error)
    }
  }

  @Test
  fun `unknown actions remain unsupported with editable focus`() {
    assertEquals(ImeActionStep.UNSUPPORTED, ImeActionStep.select("unknown", true, 30))
  }

  @Test
  fun `a live input connection routes every action through the editor action`() {
    for (sdkInt in listOf(29, 30)) {
      for (action in actions) {
        val step =
          ImeActionStep.select(
            action,
            hasFocusedEditable = true,
            sdkInt = sdkInt,
            imeConnectionAvailable = true,
          )
        assertEquals("$action on API $sdkInt", ImeActionStep.EDITOR_ACTION, step)
        assertEquals(ImeActionMechanism.EDITOR_ACTION, step.mechanism)
        assertNull(step.error)
      }
    }
  }

  @Test
  fun `without an input connection next and previous fall back to the traversal step`() {
    for (action in listOf("next", "previous")) {
      val step = ImeActionStep.select(action, true, 30, imeConnectionAvailable = false)
      assertEquals(ImeActionMechanism.FOCUS_TRAVERSAL, step.mechanism)
    }
  }

  @Test
  fun `a live input connection never rescues a missing focus or an unknown action`() {
    assertEquals(
      ImeActionStep.NO_FOCUSED_EDITABLE,
      ImeActionStep.select("next", false, 30, imeConnectionAvailable = true),
    )
    assertEquals(
      ImeActionStep.UNSUPPORTED,
      ImeActionStep.select("unknown", true, 30, imeConnectionAvailable = true),
    )
  }

  @Test
  fun `each mechanism reports its wire name`() {
    assertEquals(
      listOf("editor-action", "focus-traversal", "ime-enter", "keycode-enter"),
      ImeActionMechanism.entries.map { it.wire },
    )
  }
}
