package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Replays InputConnection traces captured from real Gboard on API 36 (#7495) against the GBOARD
 * profile. The trace files are the unmodified logcat output of the DVIC probe app; only the device
 * specific fields (timestamps, pid/tid, call counters) are ignored.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24])
class GboardCapturedTraceTest {
  private data class TraceCall(
    val field: String,
    val index: Int,
    val name: String,
    val args: String,
    val selection: Int,
    val composingStart: Int,
    val composingEnd: Int,
    val text: String,
  )

  @Test
  fun `captured gboard traces never compose text`() {
    TRACE_FILES.flatMap(::load).forEach { call ->
      assertTrue(
        "${call.name} is composing, which real Gboard does not do",
        call.name != "setComposingText" && call.name != "setComposingRegion",
      )
      assertEquals(-1, call.composingStart)
      assertEquals(-1, call.composingEnd)
    }
  }

  @Test
  fun `gboard profile matches captured typing then caret move then typing`() {
    val captured =
      (load("gboard-phase1-typed.txt") + load("gboard-phase2-caretmove-type.txt")).filter {
        it.field == "plain" && it.index <= LAST_PLAIN_CALL
      }
    val caretMoveIndex = captured.indexOfFirst { it.name == "finishComposingText" }
    val typedCalls = captured.take(caretMoveIndex)
    val postMoveCalls = captured.drop(caretMoveIndex + 1)
    val caretAfterMove = captured[caretMoveIndex].selection
    val policy = ConfigurableTypingPolicy(KeyboardProfiles.GBOARD.behavior)
    val editor = FakeEditor()

    val typedOps = typedCalls.flatMap { call ->
      type(policy, editor, call.args.commitTextArgument())
    }
    assertEquals(typedCalls.map(::expectedOp), typedOps)
    assertEquals(typedCalls.last().text, editor.text)

    editor.setSelection(caretAfterMove)
    // Gboard's finishComposingText on a caret move is a no-op (composing stayed -1..-1 around it),
    // so the profile matches it by emitting nothing, in particular no setComposingRegion.
    val caretMoveOps = policy.onSelectionChanged(editor.snapshot())
    assertTrue("caret move emitted $caretMoveOps", caretMoveOps.isEmpty())

    val postMoveOps = postMoveCalls.flatMap { type(policy, editor, it.args.commitTextArgument()) }
    assertEquals(postMoveCalls.map(::expectedOp), postMoveOps)
    assertEquals(postMoveCalls.last().text, editor.text)
    assertEquals(postMoveCalls.last().selection, editor.selectionStart)
    assertEquals(postMoveCalls.last().composingStart, editor.composingStart)
  }

  @Test
  fun `a multi-character string in one call emits the captured bare commitText sequence`() {
    val captured = load("gboard-phase1-typed.txt").filter { it.field == "plain" }
    val word = captured.take(5)
    val policy = ConfigurableTypingPolicy(KeyboardProfiles.GBOARD.behavior)
    val editor = FakeEditor()

    val ops = type(policy, editor, word.joinToString("") { it.args.commitTextArgument() })

    assertEquals(word.map(::expectedOp), ops)
    assertTrue("batch wrapper emitted: $ops", ops.none { it is ImeOp.BeginBatchEdit })
    assertTrue("batch wrapper emitted: $ops", ops.none { it is ImeOp.EndBatchEdit })
    assertEquals(word.last().text, editor.text)
  }

  private fun type(
    policy: ConfigurableTypingPolicy,
    editor: FakeEditor,
    text: String,
  ): List<ImeOp> = policy.onText(text, editor.snapshot()).also(editor::apply)

  private fun expectedOp(call: TraceCall): ImeOp {
    require(call.name == "commitText") { "unsupported captured call ${call.name}" }
    return ImeOp.CommitText(call.args.commitTextArgument())
  }

  private fun String.commitTextArgument(): String = removePrefix("'").substringBeforeLast("',")

  private fun load(resource: String): List<TraceCall> {
    val stream =
      requireNotNull(javaClass.classLoader?.getResourceAsStream("ime-traces/$resource")) {
        "missing trace resource $resource"
      }
    return stream.bufferedReader().readLines().mapNotNull { line ->
      LINE.matchEntire(line)?.destructured?.let { (field, index, name, args, sel, cs, ce, text) ->
        TraceCall(field, index.toInt(), name, args, sel.toInt(), cs.toInt(), ce.toInt(), text)
      }
    }
  }

  private companion object {
    val TRACE_FILES =
      listOf(
        "gboard-phase1-typed.txt",
        "gboard-phase2-caretmove-type.txt",
        "gboard-autocorrect-field.txt",
      )
    // Trace call #17 onward is the focus change into the second probe field.
    const val LAST_PLAIN_CALL = 16
    val LINE =
      Regex(
        """.* DVIC\s*: (\w+) #(\d+) (\w+)\((.*?)\)(?:=\w+)? sel=(\d+)\.\.\d+ comp=(-?\d+)\.\.(-?\d+) text=\[(.*)]""",
      )
  }
}
