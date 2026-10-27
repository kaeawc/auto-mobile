package dev.jasonpearson.automobile.ctrlproxy.ime

import android.text.InputType
import dev.jasonpearson.automobile.protocol.ImeTextDelivery
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImeCommitDriverTraceTest {
  private data class Replay(
    val sink: ImeCommitDriverFixtures.FakeImeCommitSink,
    val result: ImeCommitResult,
    val lines: List<String>,
    val calls: List<String>,
  )

  private fun replay(
    scenario: String,
    traced: Boolean,
    inputType: Int = InputType.TYPE_CLASS_TEXT,
    text: String = if (scenario == "keys") "A !" else TEXT,
  ): Replay {
    val sink = ImeCommitDriverFixtures.FakeImeCommitSink(inputType)
    sink.editorText = BASELINE
    if (scenario == "resume") {
      sink.beforeCommit = { index -> if (index == 3) sink.stale = true }
      sink.beforeContinuation = {
        if (sink.stale) {
          sink.generation++
          sink.stale = false
        }
      }
    } else if (scenario == "consume") {
      sink.afterCommit = {
        if (sink.committedChars.last() == " ") {
          sink.editorText = BASELINE
          sink.generation++
        }
      }
    }
    val recorder = ImeTraceRecorder(elapsedRealtimeMs = { sink.clockMs }, emit = {})
    val trace =
      if (traced)
        object : ImeDriverTrace {
          override fun record(event: String, fields: Array<out Pair<String, Any?>>) {
            recorder.record(
              event,
              "gen" to sink.generation,
              "commitActive" to true,
              "commit" to 1L,
              *fields,
            )
          }
        }
      else ImeDriverTrace.NONE
    val calls = mutableListOf<String>()
    val observedSink =
      object : ImeCommitSink by sink {
        override fun connectionGeneration(): Long {
          calls.add("connectionGeneration")
          return sink.connectionGeneration()
        }

        override fun editorIdentity(): String? {
          calls.add("editorIdentity")
          return sink.editorIdentity()
        }

        override fun startedByRestart(): Boolean {
          calls.add("startedByRestart")
          return sink.startedByRestart()
        }

        override fun readEditorTextBeforeCursor(maxChars: Int): String? {
          calls.add("readEditorTextBeforeCursor")
          return sink.readEditorTextBeforeCursor(maxChars)
        }

        override fun nowMs(): Long {
          calls.add("nowMs")
          return sink.nowMs()
        }

        override fun editorInputType(): Int? {
          calls.add("editorInputType")
          return sink.editorInputType()
        }

        override fun commitChar(ch: CharSequence): Boolean {
          calls.add("commitChar")
          return sink.commitChar(ch)
        }

        override fun supportsKeyEvents(units: List<String>): Boolean {
          calls.add("supportsKeyEvents")
          return sink.supportsKeyEvents(units)
        }

        override fun sendKeyEventUnit(unit: String): Boolean {
          calls.add("sendKeyEventUnit")
          return sink.sendKeyEventUnit(unit)
        }

        override fun finishComposing(): Boolean {
          calls.add("finishComposing")
          return sink.finishComposing()
        }

        override fun readTextBeforeCursor(maxChars: Int): String? {
          calls.add("readTextBeforeCursor")
          return sink.readTextBeforeCursor(maxChars)
        }

        override fun postDelayed(delayMs: Long, action: () -> Unit) {
          calls.add("postDelayed")
          sink.postDelayed(delayMs, action)
        }

        override fun syncEditorState(): Boolean {
          calls.add("syncEditorState")
          return sink.syncEditorState()
        }

        override fun switchToIme(imeId: String) {
          calls.add("switchToIme")
          sink.switchToIme(imeId)
        }
      }
    val driver =
      ImeCommitDriver(
        observedSink,
        { text -> Regex("\\X").findAll(text).map { it.value }.toList() },
        trace,
      )
    var result: ImeCommitResult? = null
    driver.commit(
      ImeCommitRequest(
        text,
        "prior",
        delivery = if (scenario == "keys") ImeTextDelivery.KEY_EVENTS else ImeTextDelivery.COMMIT,
      ),
    ) {
      result = it
    }
    if (scenario == "cancel") driver.cancel("IME commit superseded by another request")
    sink.drain()
    return Replay(sink, requireNotNull(result), recorder.snapshot(), calls)
  }

  @Test
  fun `all scenarios preserve sink effects and result without text in diagnostics`() {
    for ((scenario, inputType) in
      listOf("plain", "resume", "consume", "keys").map { it to InputType.TYPE_CLASS_TEXT } +
        listOf("resume" to PASSWORD_TYPES.first(), "keys" to PASSWORD_TYPES.first())) {
      val plain = replay(scenario, false, inputType)
      val traced = replay(scenario, true, inputType)
      assertEquals(plain.calls, traced.calls)
      assertEquals(plain.result, traced.result)
      assertEquals(plain.sink.committedChars, traced.sink.committedChars)
      assertEquals(plain.sink.sentKeyUnits, traced.sink.sentKeyUnits)
      assertEquals(plain.sink.delays, traced.sink.delays)
      assertEquals(plain.sink.readSizes, traced.sink.readSizes)
      assertEquals(plain.sink.editorReads, traced.sink.editorReads)
      assertEquals(plain.sink.syncCalls, traced.sink.syncCalls)
      assertEquals(plain.sink.events, traced.sink.events)
      assertEquals(plain.sink.switchedImeIds, traced.sink.switchedImeIds)
      assertEquals(plain.sink.clockMs, traced.sink.clockMs)
      for (line in traced.lines) {
        assertTrue(line, LINE.matches(line))
        for (secret in listOf(BASELINE, "Zq7Xw9", "Kp4", "Vb2", TEXT)) assertFalse(
          line.contains(secret),
        )
        for (unit in traced.sink.committedChars.filter { it.length > 1 }) assertFalse(
          line.contains(unit),
        )
      }
    }
  }

  @Test
  fun `plain commit has ordered unit indices kinds and lengths then completion`() {
    val replay = replay("plain", true)
    val dispatched = replay.lines.filter { it.contains(" event=unitDispatched ") }
    assertEquals(TEXT.length, dispatched.size)
    for ((index, unit) in TEXT.withIndex()) {
      val kind =
        when (unit) {
          ' ' -> "space"
          '\n' -> "newline"
          else -> "word"
        }
      assertTrue(dispatched[index].endsWith("index=$index kind=$kind length=1"))
    }
    assertEquals(
      List(TEXT.length) { "unitDispatched" } + listOf("decision", "complete"),
      replay.lines.map { it.substringAfter("event=").substringBefore(' ') },
    )
    assertTrue(
      replay.lines
        .last()
        .endsWith("success=true partial=false committedUnits=${TEXT.length} code=ok"),
    )
  }

  @Test
  fun `retained prefix records restart read back resume and resend in order`() {
    val lines = replay("resume", true).lines
    val events = lines.map { it.substringAfter("event=").substringBefore(' ') }
    val start = events.indexOf("reconcileStarted")
    assertEquals(
      listOf("reconcileStarted", "readBack", "decision", "resend", "unitDispatched"),
      events.subList(start, start + 5),
    )
    assertTrue(
      lines[start].endsWith("reason=generationChanged postDispatch=false fromGen=0 toGen=1"),
    )
    assertTrue(
      lines[start + 1].contains(
        "confirmed=3 startedByRestart=true postDispatch=false lastResumeConfirmed=-1",
      ),
    )
    assertTrue(lines[start + 2].contains("kind=resume confirmed=3"))
    assertTrue(lines[start + 3].endsWith("index=3 resumes=1"))
  }

  @Test
  fun `consume to empty records consumed decision and continues`() {
    val replay = replay("consume", true)
    assertTrue(replay.result.success)
    assertTrue(replay.lines.any { it.endsWith("kind=consumed confirmed=0") })
    assertFalse(replay.lines.any { it.contains("event=resend") })
    assertFalse(replay.lines.any { it.contains("reason=noneApplied") })
  }

  @Test
  fun `key event units include delivery and punctuation kind`() {
    val lines = replay("keys", true).lines
    val fields =
      lines.filter { it.contains("event=unitDispatched") }.map { it.substringAfter("commit=1 ") }
    assertEquals(
      listOf(
        "index=0 kind=word length=1 delivery=keyEvents",
        "index=1 kind=space length=1 delivery=keyEvents",
        "index=2 kind=punct length=1 delivery=keyEvents",
      ),
      fields,
    )
    assertEquals(
      listOf("unitDispatched", "unitDispatched", "unitDispatched", "decision", "complete"),
      lines.map { it.substringAfter("event=").substringBefore(' ') },
    )
  }

  @Test
  fun `password dispatch hides unit structure for commit and key events`() {
    for (inputType in PASSWORD_TYPES) {
      for (scenario in listOf("plain", "keys")) {
        val replay = replay(scenario, true, inputType, "Ab1!x Y")
        assertTrue(replay.result.success)
        val dispatched = replay.lines.filter { it.contains("event=unitDispatched") }
        assertEquals(7, dispatched.size)
        for ((index, line) in dispatched.withIndex()) {
          assertTrue(line.endsWith("index=$index secure=true"))
          assertFalse(line.contains("kind="))
          assertFalse(line.contains("length="))
        }
      }
    }
  }

  @Test
  fun `password restart read back hides text lengths`() {
    val lines = replay("resume", true, PASSWORD_TYPES.first(), "Ab1!x Y").lines
    val readBack = lines.filter { it.contains("event=readBack") }
    assertTrue(readBack.isNotEmpty())
    for (line in readBack) {
      assertTrue(line.contains("secure=true"))
      for (field in listOf("baselineLength=", "nowLength=", "deltaLength=")) assertFalse(
        line.contains(field),
      )
      for (field in
        listOf(
          "dispatchedCount=",
          "confirmed=",
          "startedByRestart=",
          "postDispatch=",
          "lastResumeConfirmed=",
        )) assertTrue(
        line.contains(field),
      )
    }
  }

  @Test
  fun `unknown cancellation reason records other without error prose`() {
    val replay = replay("cancel", true)
    assertFalse(replay.result.success)
    assertTrue(replay.lines.last().endsWith("code=other"))
    assertTrue(replay.lines.all { !it.contains("superseded") })
  }

  companion object {
    private val PASSWORD_TYPES =
      listOf(
        InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
        InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
        InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
        InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD,
      )
    private const val TEXT = "Zq7Xw9 Kp4\nVb2"
    private const val BASELINE = "BaselineSecret"
    private val LINE = Regex("^seq=\\d+ t=\\d+ event=[A-Za-z]+( [A-Za-z]+=[A-Za-z0-9_.:-]+)*$")
  }
}
