package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard

class KeyboardController {
  private var shiftState = ShiftState.OFF
  private var page = KeyPage.LETTERS
  private var enterLabel = "↵"

  fun configure(config: EditorConfig) {
    page = if (config.inputType.isNumericOrPhone()) KeyPage.SYMBOLS else KeyPage.LETTERS
    shiftState = if (config.inputType.hasCapSentences()) ShiftState.SHIFTED else ShiftState.OFF
    enterLabel = config.enterLabel()
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
      enterLabel = enterLabel,
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
      special(KeyType.ENTER, enterLabel),
    )

  private fun special(type: KeyType, label: String, widthWeight: Float = 1f): KeyboardKey =
    KeyboardKey(type = type, label = label, widthWeight = widthWeight)
}
