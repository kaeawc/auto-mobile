package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

enum class EnterStrategy {
  KEY_EVENT,
  COMMIT_NEWLINE,
}

enum class BackspaceStrategy {
  DELETE_SURROUNDING,
  KEY_EVENT,
}

data class TypingBehavior(
  val composeWords: Boolean,
  val enterStrategy: EnterStrategy,
  val backspaceStrategy: BackspaceStrategy,
  val recomposeOnCursorMove: Boolean,
  val recomposeOnBackspaceIntoWord: Boolean,
  val batchEdits: Boolean,
)
