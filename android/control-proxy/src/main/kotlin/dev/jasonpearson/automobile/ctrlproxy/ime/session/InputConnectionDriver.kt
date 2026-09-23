package dev.jasonpearson.automobile.ctrlproxy.ime.session

import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.ImeOp

class InputConnectionDriver(private val connection: ImeConnection) {
  fun execute(ops: List<ImeOp>): Boolean {
    for (op in ops) {
      val succeeded =
        when (op) {
          is ImeOp.CommitText -> connection.commitText(op.text)
          is ImeOp.SetComposingText -> connection.setComposingText(op.text)
          ImeOp.FinishComposingText -> connection.finishComposingText()
          is ImeOp.SetComposingRegion -> connection.setComposingRegion(op.start, op.end)
          is ImeOp.DeleteSurroundingText -> connection.deleteSurroundingText(op.before, op.after)
          is ImeOp.SendKey -> connection.sendDownUpKey(op.keyCode)
          is ImeOp.PerformEditorAction -> connection.performEditorAction(op.actionId)
          ImeOp.BeginBatchEdit -> connection.beginBatchEdit()
          ImeOp.EndBatchEdit -> connection.endBatchEdit()
        }
      if (!succeeded) return false
    }
    return true
  }
}
