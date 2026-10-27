package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard

import android.text.InputType

internal fun Int.isNumericOrPhone(): Boolean =
  (this and InputType.TYPE_MASK_CLASS) in
    setOf(InputType.TYPE_CLASS_NUMBER, InputType.TYPE_CLASS_PHONE)

internal fun Int.hasCapSentences(): Boolean = this and InputType.TYPE_TEXT_FLAG_CAP_SENTENCES != 0

internal fun EditorConfig.enterLabel(): String {
  // These values mirror android.view.inputmethod.EditorInfo action and flag constants.
  val actionMask = 0xff
  val actionGo = 2
  val actionSearch = 3
  val actionSend = 4
  val actionNext = 5
  val actionDone = 6
  val actionPrevious = 7
  val noEnterAction = 0x40000000
  val multiline = 0x20000
  if (imeOptions and noEnterAction != 0 || inputType and multiline != 0) return "↵"
  return when (imeOptions and actionMask) {
    actionGo -> "Go"
    actionSearch -> "Search"
    actionSend -> "Send"
    actionNext -> "Next"
    actionDone -> "Done"
    actionPrevious -> "Prev"
    else -> "↵"
  }
}

internal fun ShiftState.next(): ShiftState =
  when (this) {
    ShiftState.OFF -> ShiftState.SHIFTED
    ShiftState.SHIFTED -> ShiftState.CAPS_LOCK
    ShiftState.CAPS_LOCK -> ShiftState.OFF
  }
