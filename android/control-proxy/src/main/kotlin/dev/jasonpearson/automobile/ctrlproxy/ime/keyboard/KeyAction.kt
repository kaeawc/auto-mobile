package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard

sealed interface KeyAction {
  data class Text(val text: String) : KeyAction

  data object Backspace : KeyAction

  data object Enter : KeyAction

  data object SwitchIme : KeyAction
}
