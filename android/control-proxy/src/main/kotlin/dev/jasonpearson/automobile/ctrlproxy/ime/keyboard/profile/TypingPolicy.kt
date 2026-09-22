package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.EditorConfig

interface TypingPolicy {
  fun onText(text: String, snapshot: TextSnapshot): List<ImeOp>

  fun onBackspace(snapshot: TextSnapshot): List<ImeOp>

  fun onEnter(config: EditorConfig, snapshot: TextSnapshot): List<ImeOp>

  fun onSelectionChanged(snapshot: TextSnapshot): List<ImeOp>

  fun onFinishInput(): List<ImeOp>
}
