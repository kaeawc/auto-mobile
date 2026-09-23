package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard

import android.text.InputType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class KeyboardControllerTest {
  @Test
  fun `typing a character reflects shift state and consumes one-shot shift`() {
    val controller = KeyboardController()

    assertEquals(KeyAction.Text("a"), controller.press(character(controller, "a")))

    controller.press(key(controller, KeyType.SHIFT))
    assertEquals(KeyAction.Text("A"), controller.press(character(controller, "A")))
    assertEquals(ShiftState.OFF, controller.uiState().shiftState)

    controller.press(key(controller, KeyType.SHIFT))
    controller.press(key(controller, KeyType.SHIFT))
    assertEquals(KeyAction.Text("A"), controller.press(character(controller, "A")))
    assertEquals(ShiftState.CAPS_LOCK, controller.uiState().shiftState)
  }

  @Test
  fun `shift cycles through off shifted caps lock and off`() {
    val controller = KeyboardController()

    assertNull(controller.press(key(controller, KeyType.SHIFT)))
    assertEquals(ShiftState.SHIFTED, controller.uiState().shiftState)
    assertNull(controller.press(key(controller, KeyType.SHIFT)))
    assertEquals(ShiftState.CAPS_LOCK, controller.uiState().shiftState)
    assertNull(controller.press(key(controller, KeyType.SHIFT)))
    assertEquals(ShiftState.OFF, controller.uiState().shiftState)
  }

  @Test
  fun `page toggles navigate between letters symbols and alternate symbols`() {
    val controller = KeyboardController()

    controller.press(key(controller, KeyType.PAGE_TOGGLE))
    assertEquals(KeyPage.SYMBOLS, controller.uiState().page)
    controller.press(key(controller, KeyType.SYMBOLS_ALT_TOGGLE))
    assertEquals(KeyPage.SYMBOLS_ALT, controller.uiState().page)
    controller.press(key(controller, KeyType.SYMBOLS_ALT_TOGGLE))
    assertEquals(KeyPage.SYMBOLS, controller.uiState().page)
    controller.press(key(controller, KeyType.PAGE_TOGGLE))
    assertEquals(KeyPage.LETTERS, controller.uiState().page)
  }

  @Test
  fun `numeric input starts on symbols`() {
    val controller = KeyboardController()

    controller.configure(EditorConfig(inputType = InputType.TYPE_CLASS_NUMBER, imeOptions = 0))

    assertEquals(KeyPage.SYMBOLS, controller.uiState().page)
  }

  @Test
  fun `cap sentences input starts shifted`() {
    val controller = KeyboardController()

    controller.configure(
      EditorConfig(
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES,
        imeOptions = 0,
      )
    )

    assertEquals(ShiftState.SHIFTED, controller.uiState().shiftState)
  }

  @Test
  fun `non character keys return their input connection actions`() {
    val controller = KeyboardController()

    assertEquals(KeyAction.Backspace, controller.press(key(controller, KeyType.BACKSPACE)))
    assertEquals(KeyAction.Enter, controller.press(key(controller, KeyType.ENTER)))
    assertEquals(KeyAction.SwitchIme, controller.press(key(controller, KeyType.GLOBE)))
    assertEquals(KeyAction.Text(" "), controller.press(key(controller, KeyType.SPACE)))
  }

  @Test
  fun `all rendered character keys have output`() {
    val controller = KeyboardController()

    assertCharacterOutputs(controller)
    controller.press(key(controller, KeyType.PAGE_TOGGLE))
    assertCharacterOutputs(controller)
    controller.press(key(controller, KeyType.SYMBOLS_ALT_TOGGLE))
    assertCharacterOutputs(controller)
  }

  @Test
  fun `enter label follows editor actions`() {
    val labels = mapOf(2 to "Go", 3 to "Search", 4 to "Send", 5 to "Next", 6 to "Done", 7 to "Prev")
    labels.forEach { (action, label) ->
      val controller = KeyboardController()
      controller.configure(EditorConfig(InputType.TYPE_CLASS_TEXT, action))
      assertEquals(label, controller.uiState().enterLabel)
    }
  }

  @Test
  fun `enter label falls back for unspecified action`() {
    val controller = KeyboardController()
    controller.configure(EditorConfig(InputType.TYPE_CLASS_TEXT, 0))
    assertEquals("↵", controller.uiState().enterLabel)
    controller.configure(EditorConfig(InputType.TYPE_CLASS_TEXT, 1))
    assertEquals("↵", controller.uiState().enterLabel)
  }

  @Test
  fun `no enter action flag overrides editor action label`() {
    val controller = KeyboardController()
    controller.configure(EditorConfig(InputType.TYPE_CLASS_TEXT, 0x40000000 or 3))
    assertEquals("↵", controller.uiState().enterLabel)
  }

  @Test
  fun `multiline input overrides editor action label`() {
    val controller = KeyboardController()
    controller.configure(
      EditorConfig(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE, 3)
    )
    assertEquals("↵", controller.uiState().enterLabel)
  }

  private fun character(controller: KeyboardController, label: String): KeyboardKey =
    controller.uiState().rows.flatten().first { it.type == KeyType.CHAR && it.label == label }

  private fun key(controller: KeyboardController, type: KeyType): KeyboardKey =
    controller.uiState().rows.flatten().first { it.type == type }

  private fun assertCharacterOutputs(controller: KeyboardController) {
    controller
      .uiState()
      .rows
      .flatten()
      .filter { it.type == KeyType.CHAR }
      .forEach {
        assertNotNull(it.output)
      }
  }
}
