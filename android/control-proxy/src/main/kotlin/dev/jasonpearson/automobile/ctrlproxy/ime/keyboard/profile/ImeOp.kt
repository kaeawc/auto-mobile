package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

sealed interface ImeOp {
  data class CommitText(val text: String) : ImeOp

  data class SetComposingText(val text: String, val newCursorPosition: Int = 1) : ImeOp

  data object FinishComposingText : ImeOp

  data class SetComposingRegion(val start: Int, val end: Int) : ImeOp

  data class SetSelection(val start: Int, val end: Int) : ImeOp

  data class DeleteSurroundingText(val before: Int, val after: Int) : ImeOp

  data class SendKey(val keyCode: Int) : ImeOp

  data class PerformEditorAction(val actionId: Int) : ImeOp

  data object BeginBatchEdit : ImeOp

  data object EndBatchEdit : ImeOp
}
