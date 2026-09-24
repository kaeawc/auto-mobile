package dev.jasonpearson.automobile.ctrlproxy.ime

import android.text.InputType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ImeCommitDriverTest {
  @Test
  fun `text password field is refused and prior IME is restored`() {
    assertPasswordRefused(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
  }

  @Test
  fun `visible text password field is refused and prior IME is restored`() {
    assertPasswordRefused(
      InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
    )
  }

  @Test
  fun `web password field is refused and prior IME is restored`() {
    assertPasswordRefused(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)
  }

  @Test
  fun `number password field is refused and prior IME is restored`() {
    assertPasswordRefused(InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD)
  }

  @Test
  fun `normal text commits each character in order and restores prior IME`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

    val result = commit(sink, "hello *world*", PRIOR_IME_ID)

    assertTrue(result.success)
    assertNull(result.error)
    assertEquals("hello *world*", sink.committedChars.joinToString(separator = ""))
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
    assertTrue(sink.delays.isEmpty())
  }

  @Test
  fun `multi-span commit waits for conversion before typing next span`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, call -> if (call <= 2) "`a`" else "a" }
    var result: ImeCommitResult? = null

    ImeCommitDriver(sink).commit("`a` `b`", PRIOR_IME_ID) { result = it }

    assertEquals("`a`", sink.committedChars.joinToString(""))
    assertNull(result)
    sink.drain()
    assertTrue(result!!.success)
    assertEquals("`a` `b`", sink.committedChars.joinToString(""))
    assertEquals(listOf(40L, 40L), sink.delays)
    assertEquals(listOf(3, 3, 3), sink.readSizes)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
    assertEquals(listOf("finish", "finish"), sink.events.filter { it == "finish" })
  }

  @Test
  fun `conversion timeout proceeds with next span`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, _ -> "`a`" }

    val result = commit(sink, "`a``b`", PRIOR_IME_ID)

    assertTrue(result.success)
    assertEquals("`a``b`", sink.committedChars.joinToString(""))
    assertEquals(12, sink.delays.size)
    assertEquals(13, sink.readSizes.size)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `empty read-back falls back to the bounded settle window`() {
    // Editors without text retrieval return "" (not null) from getTextBeforeCursor; the driver
    // must keep polling to the ceiling rather than treat "" as converted and race ahead.
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, _ -> "" }

    val result = commit(sink, "`a``b`", PRIOR_IME_ID)

    assertTrue(result.success)
    assertEquals("`a``b`", sink.committedChars.joinToString(""))
    assertEquals(12, sink.delays.size)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `plain text and one span commit without polling`() {
    for (text in listOf("plain", "`code`", "")) {
      val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

      val result = commit(sink, text, PRIOR_IME_ID)

      assertTrue(result.success)
      assertEquals(text, sink.committedChars.joinToString(""))
      assertTrue(sink.delays.isEmpty())
      assertTrue(sink.readSizes.isEmpty())
      assertEquals(1, sink.events.count { it == "finish" })
      assertEquals(listOf("finish", "sync", "switch"), sink.events.takeLast(3))
    }
  }

  @Test
  fun `null prior IME commits without switching keyboards`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

    val result = commit(sink, "abc", priorImeId = null)

    assertTrue(result.success)
    assertEquals(listOf("a", "b", "c"), sink.committedChars)
    assertTrue(sink.switchedImeIds.isEmpty())
  }

  @Test
  fun `missing editor input type fails without committing`() {
    val sink = FakeImeCommitSink(inputType = null)

    val result = commit(sink, "abc", priorImeId = null)

    assertFalse(result.success)
    assertEquals("No active input connection", result.error)
    assertTrue(sink.committedChars.isEmpty())
  }

  @Test
  fun `lost connection during second character fails and restores prior IME`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT, failAtCommitIndex = 1)

    val result = commit(sink, "abc", PRIOR_IME_ID)

    assertFalse(result.success)
    assertEquals("Input connection lost during commit", result.error)
    assertEquals(listOf("a"), sink.committedChars)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `restore switches only when a prior IME is provided`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    val driver = ImeCommitDriver(sink)

    driver.restoreIfNeeded(PRIOR_IME_ID)
    driver.restoreIfNeeded(null)

    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  private fun assertPasswordRefused(inputType: Int) {
    val sink = FakeImeCommitSink(inputType = inputType)

    val result = commit(sink, "secret", PRIOR_IME_ID)

    assertFalse(result.success)
    assertEquals("Cannot commit text into a password field", result.error)
    assertTrue(sink.committedChars.isEmpty())
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `successful commit finishes composition after the last char and before restoring`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

    commit(sink, "ab", PRIOR_IME_ID)

    assertEquals(listOf("char", "char", "finish", "sync", "switch"), sink.events)
  }

  @Test
  fun `commit without an IME switch still finishes composition`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

    commit(sink, "ab", priorImeId = null)

    assertEquals(listOf("char", "char", "finish", "sync"), sink.events)
  }

  @Test
  fun `editor sync barrier runs before prior IME is restored`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

    val result = commit(sink, "ab", PRIOR_IME_ID)

    assertTrue(result.success)
    assertTrue(sink.events.indexOf("sync") < sink.events.indexOf("switch"))
  }

  @Test
  fun `sync failure reports failure after committing all chars and restores prior IME`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT, failSync = true)

    val result = commit(sink, "ab", PRIOR_IME_ID)

    assertFalse(result.success)
    assertEquals("Input connection lost while syncing editor state", result.error)
    assertEquals(listOf("a", "b"), sink.committedChars)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
    assertFalse("sync" in sink.events)
  }

  private fun commit(sink: FakeImeCommitSink, text: String, priorImeId: String?): ImeCommitResult {
    var result: ImeCommitResult? = null
    ImeCommitDriver(sink).commit(text, priorImeId) { result = it }
    sink.drain()
    return requireNotNull(result)
  }

  private class FakeImeCommitSink(
    private val inputType: Int?,
    private val failAtCommitIndex: Int? = null,
    private val failSync: Boolean = false,
  ) : ImeCommitSink {
    val committedChars = mutableListOf<String>()
    val switchedImeIds = mutableListOf<String>()
    val events = mutableListOf<String>()
    val delays = mutableListOf<Long>()
    val readSizes = mutableListOf<Int>()
    var readText: (Int, Int) -> String? = { _, _ -> null }
    private val pending = ArrayDeque<() -> Unit>()
    private var commitAttempts = 0

    override fun editorInputType(): Int? = inputType

    override fun commitChar(ch: CharSequence): Boolean {
      val currentAttempt = commitAttempts++
      if (currentAttempt == failAtCommitIndex) return false
      committedChars.add(ch.toString())
      events.add("char")
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
      pending.addLast(action)
    }

    fun drain() {
      while (pending.isNotEmpty()) pending.removeFirst().invoke()
    }

    override fun syncEditorState(): Boolean {
      if (failSync) return false
      events.add("sync")
      return true
    }

    override fun switchToIme(imeId: String) {
      switchedImeIds.add(imeId)
      events.add("switch")
    }
  }

  companion object {
    private const val PRIOR_IME_ID = "dev.example/.PreviousIme"
  }
}
