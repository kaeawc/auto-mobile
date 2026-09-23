package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

data class TextSnapshot(
  val textBeforeCursor: String,
  val textAfterCursor: String,
  val selectionStart: Int,
  val selectionEnd: Int,
  val composingStart: Int = -1,
  val composingEnd: Int = -1,
)
