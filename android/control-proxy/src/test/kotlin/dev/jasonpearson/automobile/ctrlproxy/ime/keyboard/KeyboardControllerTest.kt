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
