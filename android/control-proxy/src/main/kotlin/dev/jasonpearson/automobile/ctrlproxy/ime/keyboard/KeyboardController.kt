package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard

import android.text.InputType

class KeyboardController {
  private var shiftState = ShiftState.OFF
  private var page = KeyPage.LETTERS

  fun configure(config: EditorConfig) {
    page = if (config.inputType.isNumericOrPhone()) KeyPage.SYMBOLS else KeyPage.LETTERS
    shiftState = if (config.inputType.hasCapSentences()) ShiftState.SHIFTED else ShiftState.OFF
  }

  fun uiState(): KeyboardUiState =
    KeyboardUiState(
      rows =
        when (page) {
          KeyPage.LETTERS -> letterRows()
          KeyPage.SYMBOLS -> symbolRows()
          KeyPage.SYMBOLS_ALT -> alternateSymbolRows()
        },
      shiftState = shiftState,
      page = page,
    )

  fun press(key: KeyboardKey): KeyAction? =
    when (key.type) {
      KeyType.CHAR -> commitCharacter(key)
      KeyType.SPACE -> KeyAction.Text(" ")
      KeyType.BACKSPACE -> KeyAction.Backspace
      KeyType.SHIFT -> {
        shiftState = shiftState.next()
        null
      }
      KeyType.ENTER -> KeyAction.Enter
      KeyType.PAGE_TOGGLE -> {
        page = if (page == KeyPage.LETTERS) KeyPage.SYMBOLS else KeyPage.LETTERS
        null
      }
      KeyType.SYMBOLS_ALT_TOGGLE -> {
        page = if (page == KeyPage.SYMBOLS) KeyPage.SYMBOLS_ALT else KeyPage.SYMBOLS
        null
      }
      KeyType.GLOBE -> KeyAction.SwitchIme
    }

  private fun commitCharacter(key: KeyboardKey): KeyAction.Text {
    val action = KeyAction.Text(checkNotNull(key.output) { "Character keys require output" })
    if (shiftState == ShiftState.SHIFTED) shiftState = ShiftState.OFF
    return action
  }

  private fun letterRows(): List<List<KeyboardKey>> =
    listOf(
      characterRow("qwertyuiop"),
      characterRow("asdfghjkl"),
      listOf(special(KeyType.SHIFT, "⇧")) +
        characterRow("zxcvbnm") +
        special(KeyType.BACKSPACE, "⌫"),
      bottomRow("?123"),
    )

  private fun symbolRows(): List<List<KeyboardKey>> =
    listOf(
      characterRow("1234567890"),
      characterRow("@#$%&-_+/()"),
      listOf(special(KeyType.SYMBOLS_ALT_TOGGLE, "=\\<")) +
        characterRow("*\"':;!?") +
        special(KeyType.BACKSPACE, "⌫"),
      bottomRow("ABC"),
    )

  private fun alternateSymbolRows(): List<List<KeyboardKey>> =
    listOf(
      characterRow("~`|•√π÷×¶△"),
      characterRow("£¢€¥^°={}"),
      listOf(special(KeyType.SYMBOLS_ALT_TOGGLE, "?123")) +
        characterRow("\\©®™%[]") +
        special(KeyType.BACKSPACE, "⌫"),
      bottomRow("ABC"),
    )

  private fun characterRow(characters: String): List<KeyboardKey> = characters.map { character ->
    val output =
      if (page == KeyPage.LETTERS && shiftState != ShiftState.OFF) character.uppercase()
      else character.toString()
    KeyboardKey(type = KeyType.CHAR, label = output, output = output)
  }

  private fun bottomRow(pageLabel: String): List<KeyboardKey> =
    listOf(
      special(KeyType.PAGE_TOGGLE, pageLabel),
      special(KeyType.GLOBE, "◎"),
      special(KeyType.SPACE, "space", widthWeight = 4f),
      KeyboardKey(type = KeyType.CHAR, label = ".", output = "."),
      special(KeyType.ENTER, "↵"),
    )

  private fun special(type: KeyType, label: String, widthWeight: Float = 1f): KeyboardKey =
    KeyboardKey(type = type, label = label, widthWeight = widthWeight)

  private fun Int.isNumericOrPhone(): Boolean =
    (this and InputType.TYPE_MASK_CLASS) in
      setOf(InputType.TYPE_CLASS_NUMBER, InputType.TYPE_CLASS_PHONE)

  private fun Int.hasCapSentences(): Boolean = this and InputType.TYPE_TEXT_FLAG_CAP_SENTENCES != 0

  private fun ShiftState.next(): ShiftState =
    when (this) {
      ShiftState.OFF -> ShiftState.SHIFTED
      ShiftState.SHIFTED -> ShiftState.CAPS_LOCK
      ShiftState.CAPS_LOCK -> ShiftState.OFF
    }
}
