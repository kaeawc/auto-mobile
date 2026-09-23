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

    val result = ImeCommitDriver(sink).commit("hello *world*", PRIOR_IME_ID)

    assertTrue(result.success)
    assertNull(result.error)
    assertEquals("hello *world*", sink.committedChars.joinToString(separator = ""))
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `null prior IME commits without switching keyboards`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

    val result = ImeCommitDriver(sink).commit("abc", priorImeId = null)

    assertTrue(result.success)
    assertEquals(listOf("a", "b", "c"), sink.committedChars)
    assertTrue(sink.switchedImeIds.isEmpty())
  }

  @Test
  fun `missing editor input type fails without committing`() {
    val sink = FakeImeCommitSink(inputType = null)

    val result = ImeCommitDriver(sink).commit("abc", priorImeId = null)

    assertFalse(result.success)
    assertEquals("No active input connection", result.error)
    assertTrue(sink.committedChars.isEmpty())
  }

  @Test
  fun `lost connection during second character fails and restores prior IME`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT, failAtCommitIndex = 1)

    val result = ImeCommitDriver(sink).commit("abc", PRIOR_IME_ID)

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

    val result = ImeCommitDriver(sink).commit("secret", PRIOR_IME_ID)

    assertFalse(result.success)
    assertEquals("Cannot commit text into a password field", result.error)
    assertTrue(sink.committedChars.isEmpty())
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `successful commit finishes composition after the last char and before restoring`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

    ImeCommitDriver(sink).commit("ab", PRIOR_IME_ID)

    assertEquals(listOf("char", "char", "finish", "sync", "switch"), sink.events)
  }

  @Test
  fun `commit without an IME switch still finishes composition`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

    ImeCommitDriver(sink).commit("ab", priorImeId = null)

    assertEquals(listOf("char", "char", "finish", "sync"), sink.events)
  }

  @Test
  fun `editor sync barrier runs before prior IME is restored`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

    val result = ImeCommitDriver(sink).commit("ab", PRIOR_IME_ID)

    assertTrue(result.success)
    assertTrue(sink.events.indexOf("sync") < sink.events.indexOf("switch"))
  }

  @Test
  fun `sync failure reports failure after committing all chars and restores prior IME`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT, failSync = true)

    val result = ImeCommitDriver(sink).commit("ab", PRIOR_IME_ID)

    assertFalse(result.success)
    assertEquals("Input connection lost while syncing editor state", result.error)
    assertEquals(listOf("a", "b"), sink.committedChars)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
    assertFalse("sync" in sink.events)
  }

  private class FakeImeCommitSink(
    private val inputType: Int?,
    private val failAtCommitIndex: Int? = null,
    private val failSync: Boolean = false,
  ) : ImeCommitSink {
    val committedChars = mutableListOf<String>()
    val switchedImeIds = mutableListOf<String>()
    val events = mutableListOf<String>()
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
