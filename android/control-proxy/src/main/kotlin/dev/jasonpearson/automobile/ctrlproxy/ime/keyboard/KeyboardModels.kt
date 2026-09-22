package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard

enum class ShiftState {
  OFF,
  SHIFTED,
  CAPS_LOCK,
}

enum class KeyPage {
  LETTERS,
  SYMBOLS,
  SYMBOLS_ALT,
}

enum class KeyType {
  CHAR,
  SPACE,
  BACKSPACE,
  SHIFT,
  ENTER,
  PAGE_TOGGLE,
  SYMBOLS_ALT_TOGGLE,
  GLOBE,
}

data class KeyboardKey(
  val type: KeyType,
  val label: String,
  val output: String? = null,
  val widthWeight: Float = 1f,
)

data class KeyboardUiState(
  val rows: List<List<KeyboardKey>>,
  val shiftState: ShiftState,
  val page: KeyPage,
  val enterLabel: String = "↵",
)
