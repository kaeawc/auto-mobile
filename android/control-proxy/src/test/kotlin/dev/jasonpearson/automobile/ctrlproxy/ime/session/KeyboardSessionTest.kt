package dev.jasonpearson.automobile.ctrlproxy.ime.session

import android.text.InputType
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.EditorConfig
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.KeyType
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.KeyboardController
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.KeyboardKey
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.FakeEditor
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.ImeOp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyboardSessionTest {
  @Test
  fun `letter taps commit directly with direct profile`() {
    val fixture = Fixture("direct")
    fixture.typeLetters("hi")

    assertEquals("hi", fixture.connection.editor.text)
    assertEquals(-1, fixture.connection.editor.composingStart)
  }

  @Test
  fun `letter taps compose with samsung profile`() {
    val fixture = Fixture("samsung")
    fixture.typeLetters("hi")

    assertEquals("hi", fixture.connection.editor.text)
    assertEquals(0, fixture.connection.editor.composingStart)
    assertEquals(2, fixture.connection.editor.composingEnd)
  }

  @Test
  fun `letter taps commit per character with gboard profile`() {
    val fixture = Fixture("gboard")
    fixture.typeLetters("hi")

    assertEquals("hi", fixture.connection.editor.text)
    assertEquals(-1, fixture.connection.editor.composingStart)
  }

  @Test
  fun `globe key invokes switcher`() {
    val fixture = Fixture("direct")
    fixture.session.onKey(KeyboardKey(KeyType.GLOBE, "globe"), fixture.connection)

    assertEquals(1, fixture.switchCount)
  }

  @Test
  fun `profile changes persist and replace policy while unknown ids fail`() {
    val fixture = Fixture("direct")
    assertTrue(fixture.session.setActiveProfile("samsung"))
    assertEquals("samsung", fixture.store.id)
    fixture.typeLetters("a")
    assertEquals(0, fixture.connection.editor.composingStart)
    assertFalse(fixture.session.setActiveProfile("missing"))
    assertEquals("samsung", fixture.session.activeProfile().id)
  }

  @Test
  fun `automation backticks commit as separators under gboard profile`() {
    val fixture = Fixture("gboard")

    assertTrue(fixture.session.typeForAutomation("```", fixture.connection))
    assertEquals("```", fixture.connection.editor.text)
    assertEquals(3, fixture.connection.commits)
  }

  @Test
  fun `null connection is safe for taps and fails automation`() {
    val fixture = Fixture("direct")
    fixture.session.onKey(KeyboardKey(KeyType.CHAR, "a", "a"), null)
    assertFalse(fixture.session.typeForAutomation("a", null))
  }

  @Test
  fun `automation finish commits the trailing composing word`() {
    val fixture = Fixture("samsung")

    assertTrue(fixture.session.typeForAutomation("hi", fixture.connection))
    assertEquals(0, fixture.connection.editor.composingStart)

    assertTrue(fixture.session.finishComposingForAutomation(fixture.connection))
    assertEquals("hi", fixture.connection.editor.text)
    assertEquals(-1, fixture.connection.editor.composingStart)
    assertFalse(fixture.session.finishComposingForAutomation(null))
  }

  // #10411 keeps CtrlProxyIme active across a sendKeys IME span, so a second commit request
  // reuses the session: no onFinishInput/onStartInput resets it between requests. Each request
  // commits a word's graphemes in one synchronous main-thread run, so the editor's
  // onUpdateSelection echoes arrive only after the run (and after the automation finish).
  @Test
  fun `consecutive automation requests in one span type at the live caret`() {
    for (profile in listOf("gboard", "samsung", "direct")) {
      val connection = EchoingConnection()
      val session =
        KeyboardSession(
          KeyboardController(),
          MemoryStore(profile),
          object : ImeSwitcher {
            override fun switchToPrevious() = Unit
          },
        )
      session.onStartInput(EditorConfig(InputType.TYPE_CLASS_TEXT, 0), 0, 0)

      for (word in listOf("abc", "def", "one", "two")) {
        word.forEach { assertTrue(session.typeForAutomation(it.toString(), connection)) }
        assertTrue(session.finishComposingForAutomation(connection))
        connection.deliverEchoes(session)
      }

      assertEquals(profile, "abcdefonetwo", connection.editor.text)
      assertEquals(profile, 12, connection.editor.selectionStart)
      assertEquals(profile, -1, connection.editor.composingStart)
    }
  }

  private class Fixture(initialProfile: String) {
    val store = MemoryStore(initialProfile)
    val connection = ModelConnection()
    var switchCount = 0
    val session =
      KeyboardSession(
        KeyboardController(),
        store,
        object : ImeSwitcher {
          override fun switchToPrevious() {
            switchCount++
          }
        },
      )

    init {
      session.onStartInput(EditorConfig(InputType.TYPE_CLASS_TEXT, 0), 0, 0)
    }

    fun typeLetters(text: String) {
      text.forEach { char ->
        val key = session.uiState().rows.flatten().first { it.output == char.toString() }
        session.onKey(key, connection)
      }
    }
  }

  private class MemoryStore(var id: String) : KeyboardProfileStore {
    override fun activeProfileId() = id

    override fun setActiveProfileId(id: String) {
      this.id = id
    }
  }

  /**
   * Models an editor's asynchronous onUpdateSelection reports: the editor queues a report after
   * each edit (or batch) that changes its selection or composing span, and the session sees them
   * only when [deliverEchoes] runs, like a main-thread run of automation commits.
   */
  private class EchoingConnection : ImeConnection {
    val editor = FakeEditor()
    private val pending = ArrayDeque<IntArray>()
    private var reported = intArrayOf(0, 0, -1, -1)
    private var batchDepth = 0

    fun deliverEchoes(session: KeyboardSession) {
      var delivered = 0
      while (pending.isNotEmpty()) {
        val echo = pending.removeFirst()
        session.onUpdateSelection(echo[0], echo[1], echo[2], echo[3], this)
        delivered++
        assertTrue("selection echoes never settled", delivered < MAX_ECHOES)
      }
    }

    private fun edit(op: ImeOp): Boolean {
      editor.apply(listOf(op))
      if (batchDepth == 0) report()
      return true
    }

    private fun report() {
      val state =
        intArrayOf(
          editor.selectionStart,
          editor.selectionEnd,
          editor.composingStart,
          editor.composingEnd,
        )
      if (!state.contentEquals(reported)) {
        reported = state
        pending.addLast(state)
      }
    }

    override fun commitText(text: String) = edit(ImeOp.CommitText(text))

    override fun setComposingText(text: String, newCursorPosition: Int) =
      edit(ImeOp.SetComposingText(text, newCursorPosition))

    override fun finishComposingText() = edit(ImeOp.FinishComposingText)

    // Like BaseInputConnection, an out-of-range composing region is clamped to the text.
    override fun setComposingRegion(start: Int, end: Int): Boolean {
      val length = editor.text.length
      val first = minOf(start, end).coerceIn(0, length)
      val last = maxOf(start, end).coerceIn(0, length)
      return edit(ImeOp.SetComposingRegion(first, last))
    }

    override fun setSelection(start: Int, end: Int) = edit(ImeOp.SetSelection(start, end))

    override fun deleteSurroundingText(before: Int, after: Int) =
      edit(ImeOp.DeleteSurroundingText(before, after))

    override fun sendDownUpKey(keyCode: Int) = edit(ImeOp.SendKey(keyCode))

    override fun performEditorAction(actionId: Int) = true

    override fun beginBatchEdit(): Boolean {
      batchDepth++
      return true
    }

    override fun endBatchEdit(): Boolean {
      batchDepth--
      if (batchDepth == 0) report()
      return true
    }

    override fun textBeforeCursor(max: Int) = editor.snapshot().textBeforeCursor.takeLast(max)

    override fun textAfterCursor(max: Int) = editor.snapshot().textAfterCursor.take(max)

    companion object {
      const val MAX_ECHOES = 100
    }
  }

  private class ModelConnection : ImeConnection {
    val editor = FakeEditor()
    var commits = 0

    override fun commitText(text: String): Boolean {
      commits++
      editor.apply(listOf(ImeOp.CommitText(text)))
      return true
    }

    override fun setComposingText(text: String, newCursorPosition: Int): Boolean {
      editor.apply(listOf(ImeOp.SetComposingText(text, newCursorPosition)))
      return true
    }

    override fun finishComposingText(): Boolean {
      editor.apply(listOf(ImeOp.FinishComposingText))
      return true
    }

    override fun setComposingRegion(start: Int, end: Int): Boolean {
      editor.apply(listOf(ImeOp.SetComposingRegion(start, end)))
      return true
    }

    override fun setSelection(start: Int, end: Int): Boolean {
      editor.apply(listOf(ImeOp.SetSelection(start, end)))
      return true
    }

    override fun deleteSurroundingText(before: Int, after: Int): Boolean {
      editor.apply(listOf(ImeOp.DeleteSurroundingText(before, after)))
      return true
    }

    override fun sendDownUpKey(keyCode: Int): Boolean {
      editor.apply(listOf(ImeOp.SendKey(keyCode)))
      return true
    }

    override fun performEditorAction(actionId: Int) = true

    override fun beginBatchEdit() = true

    override fun endBatchEdit() = true

    override fun textBeforeCursor(max: Int) = editor.snapshot().textBeforeCursor.takeLast(max)

    override fun textAfterCursor(max: Int) = editor.snapshot().textAfterCursor.take(max)
  }
}
