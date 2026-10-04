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
}
