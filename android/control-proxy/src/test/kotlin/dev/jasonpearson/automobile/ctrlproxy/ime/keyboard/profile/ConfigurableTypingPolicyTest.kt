package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.EditorConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConfigurableTypingPolicyTest {
  @Test
  fun `direct commits every character without a composing span`() {
    val policy = policy(KeyboardProfiles.DIRECT)
    val editor = FakeEditor()

    val ops = policy.onText("hi there", editor.snapshot())
    assertEquals("hi there".map { ImeOp.CommitText(it.toString()) }, ops)
    ops.forEach { op ->
      editor.apply(listOf(op))
      assertEquals(-1, editor.composingStart)
    }
    assertEquals("hi there", editor.text)
  }

  @Test
  fun `gboard composes a word and finishes it at a separator`() {
    val policy = policy(KeyboardProfiles.GBOARD)
    val editor = FakeEditor()

    type(policy, editor, "hel")
    assertEquals("hel", editor.text)
    assertEquals(0, editor.composingStart)
    assertEquals(3, editor.composingEnd)

    type(policy, editor, "lo there")
    assertEquals("hello there", editor.text)
    assertEquals(6, editor.composingStart)
    assertEquals(11, editor.composingEnd)

    editor.apply(policy.onFinishInput())
    assertEquals("hello there", editor.text)
    assertEquals(-1, editor.composingStart)
  }

  @Test
  fun `gboard keeps hi there text and clears composition when input ends`() {
    val policy = policy(KeyboardProfiles.GBOARD)
    val editor = FakeEditor()

    type(policy, editor, "hi there")
    assertEquals("hi there", editor.text)
    assertEquals(3, editor.composingStart)
    assertEquals(8, editor.composingEnd)

    editor.apply(policy.onFinishInput())
    assertEquals("hi there", editor.text)
    assertEquals(-1, editor.composingStart)
  }

  @Test
  fun `backspace shrinks composing text and clears the empty span`() {
    val policy = policy(KeyboardProfiles.GBOARD)
    val editor = FakeEditor()
    type(policy, editor, "ab")

    editor.apply(policy.onBackspace(editor.snapshot()))
    assertEquals("a", editor.text)
    assertEquals(0, editor.composingStart)
    assertEquals(1, editor.composingEnd)

    val ops = policy.onBackspace(editor.snapshot())
    assertTrue(ops.contains(ImeOp.SetComposingText("")))
    assertTrue(ops.contains(ImeOp.FinishComposingText))
    editor.apply(ops)
    assertEquals("", editor.text)
    assertEquals(-1, editor.composingStart)
    assertEquals(-1, editor.composingEnd)
  }

  @Test
  fun `gboard backspace reopens remaining committed word`() {
    val policy = policy(KeyboardProfiles.GBOARD)
    val editor = FakeEditor()
    type(policy, editor, "hello ")
    assertEquals(-1, editor.composingStart)

    editor.apply(policy.onBackspace(editor.snapshot()))
    val ops = policy.onBackspace(editor.snapshot())
    assertTrue(ops.contains(ImeOp.SetComposingRegion(0, 4)))
    editor.apply(ops)

    assertEquals("hell", editor.text)
    assertEquals(0, editor.composingStart)
    assertEquals(4, editor.composingEnd)
  }

  @Test
  fun `samsung recomposes word under moved cursor while gboard does not`() {
    val editor = FakeEditor("hello world")
    editor.setSelection(8)
    val snapshot = editor.snapshot()

    val samsungOps = policy(KeyboardProfiles.SAMSUNG).onSelectionChanged(snapshot)
    assertEquals(listOf(ImeOp.SetComposingRegion(6, 11)), samsungOps)
    editor.apply(samsungOps)
    assertEquals("hello world", editor.text)
    assertEquals(6, editor.composingStart)
    assertEquals(11, editor.composingEnd)

    assertTrue(policy(KeyboardProfiles.GBOARD).onSelectionChanged(snapshot).isEmpty())
  }

  @Test
  fun `moving outside a composing span finishes the old word`() {
    val policy = policy(KeyboardProfiles.SAMSUNG)
    val editor = FakeEditor()
    type(policy, editor, "hello ")
    type(policy, editor, "world")
    editor.setSelection(2)

    val ops = policy.onSelectionChanged(editor.snapshot())
    assertEquals(listOf(ImeOp.FinishComposingText, ImeOp.SetComposingRegion(0, 5)), ops)
    editor.apply(ops)
    assertEquals("hello world", editor.text)
    assertEquals(0, editor.composingStart)
    assertEquals(5, editor.composingEnd)
  }

  @Test
  fun `usable single line search action wins for every profile`() {
    val editor = FakeEditor()
    val config = EditorConfig(inputType = 1, imeOptions = 3)

    KeyboardProfiles.all.forEach { profile ->
      val ops = policy(profile).onEnter(config, editor.snapshot())
      assertEquals(profile.id, listOf(ImeOp.PerformEditorAction(3)), ops)
      editor.apply(ops)
      assertEquals("", editor.text)
    }
  }

  @Test
  fun `multiline and missing actions use each profile enter strategy`() {
    val multiline = EditorConfig(inputType = 1 or 0x20000, imeOptions = 3)
    val noAction = EditorConfig(inputType = 1, imeOptions = 1)
    val unspecified = EditorConfig(inputType = 1, imeOptions = 0)

    listOf(multiline, noAction, unspecified).forEach { config ->
      assertEnterFallback(KeyboardProfiles.GBOARD, config, ImeOp.SendKey(66))
      assertEnterFallback(KeyboardProfiles.SAMSUNG, config, ImeOp.CommitText("\n"))
    }
  }

  @Test
  fun `no enter action flag blocks an otherwise usable action`() {
    val config = EditorConfig(inputType = 1, imeOptions = 0x40000000 or 3)

    assertEnterFallback(KeyboardProfiles.DIRECT, config, ImeOp.SendKey(66))
    assertEnterFallback(KeyboardProfiles.GBOARD, config, ImeOp.SendKey(66))
    assertEnterFallback(KeyboardProfiles.SAMSUNG, config, ImeOp.CommitText("\n"))
  }

  @Test
  fun `enter finishes a composing word before the action`() {
    val policy = policy(KeyboardProfiles.GBOARD)
    val editor = FakeEditor()
    type(policy, editor, "hello")

    val ops = policy.onEnter(EditorConfig(1, 3), editor.snapshot())
    assertEquals(
      listOf(
        ImeOp.BeginBatchEdit,
        ImeOp.FinishComposingText,
        ImeOp.PerformEditorAction(3),
        ImeOp.EndBatchEdit,
      ),
      ops,
    )
    editor.apply(ops)
    assertEquals("hello", editor.text)
    assertEquals(-1, editor.composingStart)
  }

  @Test
  fun `backspace deletes a selection through empty commit`() {
    val policy = policy(KeyboardProfiles.DIRECT)
    val editor = FakeEditor("hello")
    editor.setSelection(1, 4)

    val ops = policy.onBackspace(editor.snapshot())
    assertEquals(listOf(ImeOp.CommitText("")), ops)
    assertFalse(ops.any { it is ImeOp.DeleteSurroundingText })
    editor.apply(ops)
    assertEquals("ho", editor.text)
    assertEquals(-1, editor.composingStart)
  }

  @Test
  fun `finish input clears composing text and internal buffer`() {
    val policy = policy(KeyboardProfiles.GBOARD)
    val editor = FakeEditor()
    type(policy, editor, "old")

    val ops = policy.onFinishInput()
    assertEquals(listOf(ImeOp.FinishComposingText), ops)
    editor.apply(ops)
    assertEquals(-1, editor.composingStart)

    type(policy, editor, "n")
    assertEquals("oldn", editor.text)
    assertEquals(3, editor.composingStart)
    assertEquals(4, editor.composingEnd)
  }

  @Test
  fun `profile lookup ignores case and misses unknown ids`() {
    assertEquals(KeyboardProfiles.GBOARD, KeyboardProfiles.byId("GBOARD"))
    assertNull(KeyboardProfiles.byId("nonexistent"))
    assertEquals(KeyboardProfiles.GBOARD, KeyboardProfiles.DEFAULT)
  }

  private fun policy(profile: KeyboardProfile) = ConfigurableTypingPolicy(profile.behavior)

  private fun type(policy: TypingPolicy, editor: FakeEditor, text: String) {
    editor.apply(policy.onText(text, editor.snapshot()))
  }

  private fun assertEnterFallback(profile: KeyboardProfile, config: EditorConfig, expected: ImeOp) {
    val editor = FakeEditor()
    val ops = policy(profile).onEnter(config, editor.snapshot())
    assertEquals(profile.id, listOf(expected), ops)
    editor.apply(ops)
    assertEquals(profile.id, "\n", editor.text)
  }

  @Test
  fun `samsung does not re-compose on selection updates echoed from its own composing`() {
    val policy = policy(KeyboardProfiles.SAMSUNG)
    val editor = FakeEditor()

    "hel"
      .forEach { char ->
        editor.apply(policy.onText(char.toString(), editor.snapshot()))
        val echoed = policy.onSelectionChanged(editor.snapshot())
        assertTrue("unexpected ops on echoed update: $echoed", echoed.isEmpty())
      }
    assertEquals("hel", editor.text)
    assertEquals(0, editor.composingStart)
    assertEquals(3, editor.composingEnd)
  }
}
