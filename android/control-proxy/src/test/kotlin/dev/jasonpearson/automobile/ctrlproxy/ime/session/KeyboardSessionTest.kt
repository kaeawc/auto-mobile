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
  fun `letter taps compose with gboard profile`() {
    val fixture = Fixture("gboard")
    fixture.typeLetters("hi")

    assertEquals("hi", fixture.connection.editor.text)
    assertEquals(0, fixture.connection.editor.composingStart)
    assertEquals(2, fixture.connection.editor.composingEnd)
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

  private class ModelConnection : ImeConnection {
    val editor = FakeEditor()
    var commits = 0

    override fun commitText(text: String): Boolean {
      commits++
      editor.apply(listOf(ImeOp.CommitText(text)))
      return true
    }

    override fun setComposingText(text: String): Boolean {
      editor.apply(listOf(ImeOp.SetComposingText(text)))
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
