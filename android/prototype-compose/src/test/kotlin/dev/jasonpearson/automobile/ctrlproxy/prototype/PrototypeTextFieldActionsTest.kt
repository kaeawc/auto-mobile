package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.text.input.ImeAction
import org.junit.Assert.assertEquals
import org.junit.Test

class PrototypeTextFieldActionsTest {
  @Test
  fun `every authored IME action maps to its Compose action`() {
    assertEquals(ImeAction.Done, prototypeTextFieldImeAction("done", false))
    assertEquals(ImeAction.Next, prototypeTextFieldImeAction("next", false))
    assertEquals(ImeAction.Search, prototypeTextFieldImeAction("search", true))
    assertEquals(ImeAction.Send, prototypeTextFieldImeAction("send", false))
    assertEquals(ImeAction.Go, prototypeTextFieldImeAction("go", false))
  }

  @Test
  fun `onSubmit alone means done and nothing authored keeps the default`() {
    assertEquals(ImeAction.Done, prototypeTextFieldImeAction(null, true))
    assertEquals(ImeAction.Default, prototypeTextFieldImeAction(null, false))
  }
}
