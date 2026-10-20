package dev.jasonpearson.automobile.ctrlproxy.ime

import android.text.InputType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue

internal open class ImeCommitDriverFixtures {
  protected fun assertPasswordCommits(inputType: Int) {
    val sink = FakeImeCommitSink(inputType = inputType)

    val result = commit(sink, "s3cr3t", PRIOR_IME_ID)

    assertTrue(result.success)
    assertNull(result.error)
    assertEquals("s3cr3t", sink.committedChars.joinToString(separator = ""))
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  protected fun assertRejectedNewlineThenLostH(restart: Boolean) {
    val sink = newlineStrippingSink()
    val stripNewline = requireNotNull(sink.afterCommit)
    sink.afterCommit = {
      stripNewline()
      if (sink.committedChars.last() == "h" && sink.committedChars.count { it == "h" } == 1) {
        sink.editorText = requireNotNull(sink.editorText).dropLast(1)
        sink.restarting = restart
        sink.generation++
      }
    }
    val result = commit(sink, "one\ntwo three", PRIOR_IME_ID)
    assertEquals(2, sink.committedChars.count { it == "h" })
    assertEquals(1, sink.committedChars.count { it == "\n" })
    assertTrue(result.success)
    assertNull(result.error)
    assertEquals("onetwo three", sink.editorText)
    assertEquals("onetwo three", result.insertedText)
    assertEquals(13, result.committedUnits)
  }

  protected fun newlineStrippingSink(): FakeImeCommitSink {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = ""
    sink.afterCommit = {
      if (sink.committedChars.last() == "\n") {
        sink.editorText = requireNotNull(sink.editorText).dropLast(1)
        sink.generation++
      }
    }
    return sink
  }

  protected fun restartingSink(
    baseline: String,
    restart: Boolean,
    lostAt: Int = 0,
  ): FakeImeCommitSink {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = baseline
    sink.restarting = restart
    sink.beforeCommit = { index -> if (index == lostAt) sink.stale = true }
    sink.beforeContinuation = continuation@{
      if (!sink.stale) return@continuation
      if (!restart && sink.generation == 0L) {
        sink.generation = 1
        sink.identity = null
      } else {
        sink.generation = if (restart) 1 else 2
        sink.identity = "same-editor"
        sink.stale = false
      }
    }
    return sink
  }

  // The driver consumes supplied editing units. Android ICU segmentation has its own test suite;
  // the JVM's Unicode grapheme matcher supplies this fake without booting an Android runtime.
  protected fun driver(sink: FakeImeCommitSink) =
    ImeCommitDriver(sink) { text -> Regex("\\X").findAll(text).map { it.value }.toList() }

  protected fun commit(
    sink: FakeImeCommitSink,
    text: String,
    priorImeId: String?,
  ): ImeCommitResult {
    var result: ImeCommitResult? = null
    driver(sink).commit(ImeCommitRequest(text, priorImeId)) {
      result = it
    }
    sink.drain()
    return requireNotNull(result)
  }

  protected fun unicodeCorpus() =
    listOf(
      "a😀b👍🏽c👨‍👩‍👧d🇯🇵e❤️fé日本",
      "1️⃣",
      "e\u0301",
      "🏳️‍🌈",
      "👩🏽‍💻",
      "ไทย",
      "हिन्दी",
      "مرحبا",
      "한국어",
    )

  protected fun String.hasWellFormedUtf16(): Boolean {
    var index = 0
    while (index < length) {
      when {
        this[index].isHighSurrogate() -> {
          if (index + 1 >= length || !this[index + 1].isLowSurrogate()) return false
          index += 2
        }
        this[index].isLowSurrogate() -> return false
        else -> index++
      }
    }
    return true
  }

  internal class FakeImeCommitSink(
    private val inputType: Int?,
    private val failAtCommitIndex: Int? = null,
    private val failSync: Boolean = false,
    // Fail only the first N barriers, as a connection re-bound after the last unit does.
    private val failSyncCalls: Int = 0,
  ) : ImeCommitSink {
    val committedChars = mutableListOf<String>()
    val sentKeyUnits = mutableListOf<String>()
    var supportedKeyUnits: (List<String>) -> Boolean = { true }
    var afterKeyUnit: (() -> Unit)? = null
    val switchedImeIds = mutableListOf<String>()
    val events = mutableListOf<String>()
    val delays = mutableListOf<Long>()
    val readSizes = mutableListOf<Int>()
    var generation = 0L
    var identity: String? = "same-editor"
    var restarting = true
    var editorText: String? = null
    var stale = false
    var beforeCommit: ((Int) -> Unit)? = null
    var beforeContinuation: (() -> Unit)? = null
    val appliedChars = mutableListOf<String>()

    override fun connectionGeneration(): Long = generation

    override fun editorIdentity(): String? = identity

    override fun startedByRestart(): Boolean = restarting

    override fun readEditorTextBeforeCursor(maxChars: Int): String? {
      editorReads++
      return if (stale) null else editorText?.takeLast(maxChars)
    }

    var readText: (Int, Int) -> String? = { _, _ -> null }
    var afterCommit: (() -> Unit)? = null
    var afterSync: (() -> Unit)? = null
    var editorReads = 0
    var syncCalls = 0
    var clockMs = 0L
    var advanceClockOnDrain = false
    private val pending = ArrayDeque<Pair<Long, () -> Unit>>()
    private var commitAttempts = 0

    override fun editorInputType(): Int? = inputType

    override fun nowMs(): Long = clockMs

    override fun commitChar(ch: CharSequence): Boolean {
      val currentAttempt = commitAttempts++
      beforeCommit?.invoke(currentAttempt)
      if (currentAttempt == failAtCommitIndex) return false
      committedChars.add(ch.toString())
      if (!stale && editorText != null) {
        editorText += ch.toString()
        appliedChars.add(ch.toString())
      }
      events.add("char")
      afterCommit?.invoke()
      return true
    }

    override fun supportsKeyEvents(units: List<String>): Boolean = supportedKeyUnits(units)

    override fun sendKeyEventUnit(unit: String): Boolean {
      sentKeyUnits.add(unit)
      afterKeyUnit?.invoke()
      return true
    }

    override fun finishComposing(): Boolean {
      events.add("finish")
      return true
    }

    override fun readTextBeforeCursor(maxChars: Int): String? {
      readSizes.add(maxChars)
      events.add("read")
      return readText(maxChars, readSizes.size)
    }

    override fun postDelayed(delayMs: Long, action: () -> Unit) {
      delays.add(delayMs)
      pending.addLast(delayMs to action)
    }

    fun step() {
      val (delay, action) = pending.removeFirst()
      if (advanceClockOnDrain) clockMs += delay
      beforeContinuation?.invoke()
      action()
    }

    fun runUntil(condition: () -> Boolean) {
      while (!condition()) {
        check(pending.isNotEmpty()) { "No scheduled continuation" }
        step()
      }
    }

    fun drain() {
      while (pending.isNotEmpty()) step()
    }

    override fun syncEditorState(): Boolean {
      syncCalls++
      afterSync?.invoke()
      if (failSync || syncCalls <= failSyncCalls) return false
      events.add("sync")
      return true
    }

    override fun switchToIme(imeId: String) {
      switchedImeIds.add(imeId)
      events.add("switch")
    }
  }

  companion object {
    const val NONE_APPLIED_ERROR =
      "Editor restarted its input connection during IME commit; none of the dispatched text is in the editor"
    const val PRIOR_IME_ID = "dev.example/.PreviousIme"
  }
}
