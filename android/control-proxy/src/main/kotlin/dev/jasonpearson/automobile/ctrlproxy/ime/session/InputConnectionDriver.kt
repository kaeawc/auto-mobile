package dev.jasonpearson.automobile.ctrlproxy.ime.session

import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.ImeOp

class InputConnectionDriver(private val connection: ImeConnection) {
  fun execute(ops: List<ImeOp>): Boolean {
    var openBatches = 0
    try {
      for (op in ops) {
        val succeeded =
          when (op) {
            is ImeOp.CommitText -> connection.commitText(op.text)
            is ImeOp.SetComposingText -> connection.setComposingText(op.text, op.newCursorPosition)
            ImeOp.FinishComposingText -> connection.finishComposingText()
            is ImeOp.SetComposingRegion -> connection.setComposingRegion(op.start, op.end)
            is ImeOp.SetSelection -> connection.setSelection(op.start, op.end)
            is ImeOp.DeleteSurroundingText -> connection.deleteSurroundingText(op.before, op.after)
            is ImeOp.SendKey -> connection.sendDownUpKey(op.keyCode)
            is ImeOp.PerformEditorAction -> connection.performEditorAction(op.actionId)
            ImeOp.BeginBatchEdit -> connection.beginBatchEdit().also { if (it) openBatches++ }
            ImeOp.EndBatchEdit -> {
              connection.endBatchEdit()
              if (openBatches > 0) openBatches--
              true
            }
          }
        if (!succeeded) {
          closeBatches(openBatches)
          return false
        }
      }
      return true
    } catch (failure: Exception) {
      closeBatches(openBatches)
      throw failure
    }
  }

  private fun closeBatches(openBatches: Int) {
    repeat(openBatches) {
      runCatching { connection.endBatchEdit() }
    }
  }
}
