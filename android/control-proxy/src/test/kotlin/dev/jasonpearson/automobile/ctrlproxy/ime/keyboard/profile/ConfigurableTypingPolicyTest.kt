package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.EditorConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24])
class ConfigurableTypingPolicyTest {
  @Test
  fun `direct profile commits each Unicode grapheme as one operation`() {
    val cases =
      listOf(
        "👨‍👩‍👧" to listOf("👨‍👩‍👧"),
        "👍🏽" to listOf("👍🏽"),
        "🇯🇵" to listOf("🇯🇵"),
        "❤️" to listOf("❤️"),
        "1️⃣" to listOf("1️⃣"),
        "e\u0301" to listOf("e\u0301"),
        "é" to listOf("é"),
        "日本" to listOf("日", "本"),
        "a😀b👍🏽c👨‍👩‍👧d🇯🇵e❤️fé日本" to
          listOf(
            "a",
            "😀",
            "b",
            "👍🏽",
            "c",
            "👨‍👩‍👧",
            "d",
            "🇯🇵",
            "e",
            "❤️",
            "f",
            "é",
            "日",
            "本",
          ),
        "🏳️‍🌈" to listOf("🏳️‍🌈"),
        "👩🏽‍💻" to listOf("👩🏽‍💻"),
        "ไทย" to listOf("ไ", "ท", "ย"),
        "हिन्दी" to listOf("हि", "न्", "दी"),
        "مرحبا" to listOf("م", "ر", "ح", "ب", "ا"),
        "한국어" to listOf("한", "국", "어"),
      )
    cases.forEach { (input, units) ->
      val editor = FakeEditor()
      val ops = policy(KeyboardProfiles.DIRECT).onText(input, editor.snapshot())
      assertEquals(input, units.map(ImeOp::CommitText), ops)
      editor.apply(ops)
      assertEquals(input, editor.text)
      assertEquals(-1, editor.composingStart)
    }
  }

  @Test
  fun `direct profile preserves unicode corpus without lone UTF-16 surrogates`() {
    unicodeCorpus().forEach { input ->
      val editor = FakeEditor()
      val ops = policy(KeyboardProfiles.DIRECT).onText(input, editor.snapshot())
      val commits = ops.filterIsInstance<ImeOp.CommitText>().map(ImeOp.CommitText::text)

      assertTrue(
        "A commit contained a lone UTF-16 surrogate for input: $input",
        commits.all { it.hasWellFormedUtf16() },
      )
      editor.apply(ops)
      assertEquals(input, editor.text)
    }
  }

  @Test
  fun `direct profile keeps grapheme sequences whole as tracked for issue 7999`() {
    val graphemes = listOf("1️⃣", "e\u0301", "👨‍👩‍👧", "🇯🇵", "👍🏽", "🏳️‍🌈", "👩🏽‍💻")

    graphemes.forEach { grapheme ->
      val editor = FakeEditor()
      val commits =
        policy(KeyboardProfiles.DIRECT)
          .onText(grapheme, editor.snapshot())
          .filterIsInstance<ImeOp.CommitText>()
          .map(ImeOp.CommitText::text)

      assertEquals(listOf(grapheme), commits)
      editor.apply(commits.map(ImeOp::CommitText))
      assertEquals(grapheme, editor.text)
    }
  }

  @Test
  fun `gboard composes words and commits whole emoji graphemes`() {
    val cases =
      listOf(
        "👨‍👩‍👧" to listOf<ImeOp>(ImeOp.CommitText("👨‍👩‍👧")),
        "👍🏽" to listOf<ImeOp>(ImeOp.CommitText("👍🏽")),
        "🇯🇵" to listOf<ImeOp>(ImeOp.CommitText("🇯🇵")),
        "❤️" to listOf<ImeOp>(ImeOp.CommitText("❤️")),
        "1️⃣" to listOf<ImeOp>(ImeOp.CommitText("1️⃣")),
        "e\u0301" to listOf<ImeOp>(ImeOp.SetComposingText("e\u0301")),
        "é" to listOf<ImeOp>(ImeOp.SetComposingText("é")),
        "日本" to listOf<ImeOp>(ImeOp.SetComposingText("日"), ImeOp.SetComposingText("日本")),
        "a😀b👍🏽c👨‍👩‍👧d🇯🇵e❤️fé日本" to
          listOf<ImeOp>(
            ImeOp.SetComposingText("a"),
            ImeOp.FinishComposingText,
            ImeOp.CommitText("😀"),
            ImeOp.SetComposingText("b"),
            ImeOp.FinishComposingText,
            ImeOp.CommitText("👍🏽"),
            ImeOp.SetComposingText("c"),
            ImeOp.FinishComposingText,
            ImeOp.CommitText("👨‍👩‍👧"),
            ImeOp.SetComposingText("d"),
            ImeOp.FinishComposingText,
            ImeOp.CommitText("🇯🇵"),
            ImeOp.SetComposingText("e"),
            ImeOp.FinishComposingText,
            ImeOp.CommitText("❤️"),
            ImeOp.SetComposingText("f"),
            ImeOp.SetComposingText("fé"),
            ImeOp.SetComposingText("fé日"),
            ImeOp.SetComposingText("fé日本"),
          ),
        "🏳️‍🌈" to listOf<ImeOp>(ImeOp.CommitText("🏳️‍🌈")),
        "👩🏽‍💻" to listOf<ImeOp>(ImeOp.CommitText("👩🏽‍💻")),
        "ไทย" to
          listOf<ImeOp>(
            ImeOp.SetComposingText("ไ"),
            ImeOp.SetComposingText("ไท"),
            ImeOp.SetComposingText("ไทย"),
          ),
        "हिन्दी" to
          listOf<ImeOp>(
            ImeOp.SetComposingText("हि"),
            ImeOp.SetComposingText("हिन्"),
            ImeOp.SetComposingText("हिन्दी"),
          ),
        "مرحبا" to
          listOf<ImeOp>(
            ImeOp.SetComposingText("م"),
            ImeOp.SetComposingText("مر"),
            ImeOp.SetComposingText("مرح"),
            ImeOp.SetComposingText("مرحب"),
            ImeOp.SetComposingText("مرحبا"),
          ),
        "한국어" to
          listOf<ImeOp>(
            ImeOp.SetComposingText("한"),
            ImeOp.SetComposingText("한국"),
            ImeOp.SetComposingText("한국어"),
          ),
      )
    cases.forEach { (input, operations) ->
      val editor = FakeEditor()
      val expected =
        if (operations.size >= 2) listOf(ImeOp.BeginBatchEdit) + operations + ImeOp.EndBatchEdit
        else operations
      val ops = policy(KeyboardProfiles.GBOARD).onText(input, editor.snapshot())
      assertEquals(input, expected, ops)
      editor.apply(ops)
      assertEquals(input, editor.text)
    }
  }

  @Test
  fun `cursor recomposition and backspace never reopen part of a keycap`() {
    val text = "a1️⃣b"
    val policy = policy(KeyboardProfiles.SAMSUNG)
    val editor = FakeEditor(text)
    editor.setSelection(2) // After the digit, but inside the keycap grapheme.
    assertTrue(policy.onSelectionChanged(editor.snapshot()).isEmpty())

    editor.setSelection(4) // At the start of b, after the complete keycap.
    assertEquals(
      listOf(ImeOp.SetComposingRegion(4, 5)),
      policy.onSelectionChanged(editor.snapshot()),
    )

    val beforeKeycap = FakeEditor("a1️⃣")
    assertEquals(
      listOf(ImeOp.DeleteSurroundingText(3, 0)),
      policy(KeyboardProfiles.GBOARD).onBackspace(beforeKeycap.snapshot()),
    )
  }

  @Test
  fun `automation finish echo does not recompose but next cursor move does`() {
    val policy = policy(KeyboardProfiles.SAMSUNG)
    val editor = FakeEditor()
    type(policy, editor, "hello")
    editor.apply(policy.finishComposingForAutomation())

    assertEquals(-1, editor.composingStart)
    assertTrue(policy.onSelectionChanged(editor.snapshot()).isEmpty())
    editor.setSelection(3)
    assertEquals(
      listOf(ImeOp.SetComposingRegion(0, 5)),
      policy.onSelectionChanged(editor.snapshot()),
    )
  }

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
  fun `gboard automation typing commits exact text without moving the caret mid-commit`() {
    val editor = FakeEditor()

    type(policy(KeyboardProfiles.DEFAULT), editor, "hello ")

    assertEquals("hello ", editor.text)
    assertEquals(6, editor.selectionStart)
    assertEquals(-1, editor.composingStart)
    assertEquals(-1, editor.composingEnd)
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
  fun `backspace uses a one unit deletion when cursor text is unavailable`() {
    val policy = policy(KeyboardProfiles.GBOARD)
    val unknownText =
      FakeEditor("abcd").snapshot().copy(textBeforeCursor = "", textBeforeCursorAvailable = false)

    assertEquals(listOf(ImeOp.DeleteSurroundingText(1, 0)), policy.onBackspace(unknownText))
    assertTrue(policy.onBackspace(unknownText.copy(selectionStart = 0, selectionEnd = 0)).isEmpty())
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
  fun `samsung and gboard recompose word under moved cursor while direct does not`() {
    val editor = FakeEditor("hello world")
    editor.setSelection(8)
    val snapshot = editor.snapshot()

    listOf(KeyboardProfiles.SAMSUNG, KeyboardProfiles.GBOARD).forEach { profile ->
      val recomposedEditor = FakeEditor("hello world")
      recomposedEditor.setSelection(8)
      val ops = policy(profile).onSelectionChanged(recomposedEditor.snapshot())
      assertEquals(profile.id, listOf(ImeOp.SetComposingRegion(6, 11)), ops)
      recomposedEditor.apply(ops)
      assertEquals(profile.id, "hello world", recomposedEditor.text)
      assertEquals(profile.id, 6, recomposedEditor.composingStart)
      assertEquals(profile.id, 11, recomposedEditor.composingEnd)
    }

    assertTrue(policy(KeyboardProfiles.DIRECT).onSelectionChanged(snapshot).isEmpty())
  }

  @Test
  fun `samsung inserts into a recomposed word at the moved caret`() {
    val policy = policy(KeyboardProfiles.SAMSUNG)
    val editor = FakeEditor("hello world")
    editor.setSelection(8)
    editor.apply(policy.onSelectionChanged(editor.snapshot()))

    val ops = policy.onText("X", editor.snapshot())
    assertEquals(
      listOf(ImeOp.SetComposingText("woXrld"), ImeOp.SetSelection(9, 9)),
      ops,
    )
    editor.apply(ops)

    assertEquals("hello woXrld", editor.text)
    assertEquals(9, editor.selectionStart)
    assertEquals(6, editor.composingStart)
    assertEquals(12, editor.composingEnd)
  }

  @Test
  fun `gboard inserts into a recomposed word at the moved caret`() {
    val policy = policy(KeyboardProfiles.GBOARD)
    val editor = FakeEditor("hello world")
    editor.setSelection(8)
    editor.apply(policy.onSelectionChanged(editor.snapshot()))

    val ops = policy.onText("X", editor.snapshot())
    assertEquals(
      listOf(
        ImeOp.BeginBatchEdit,
        ImeOp.SetComposingText("woXrld"),
        ImeOp.SetSelection(9, 9),
        ImeOp.EndBatchEdit,
      ),
      ops,
    )
    editor.apply(ops)

    assertEquals("hello woXrld", editor.text)
    assertEquals(9, editor.selectionStart)
    assertEquals(6, editor.composingStart)
    assertEquals(12, editor.composingEnd)
  }

  // Automation commits one grapheme per onText call in a synchronous run, before the editor's
  // selection echo for the previous grapheme arrives; each call must insert after the last one.
  @Test
  fun `consecutive inserts into a recomposed word ignore a stale snapshot caret`() {
    for (profile in listOf(KeyboardProfiles.GBOARD, KeyboardProfiles.SAMSUNG)) {
      val policy = policy(profile)
      val editor = FakeEditor("hello world")
      editor.setSelection(8)
      editor.apply(policy.onSelectionChanged(editor.snapshot()))
      val stale = editor.snapshot()

      "XYZ".forEach { editor.apply(policy.onText(it.toString(), stale)) }

      assertEquals(profile.id, "hello woXYZrld", editor.text)
      assertEquals(profile.id, 11, editor.selectionStart)
    }
  }

  @Test
  fun `stale composing echoes after an automation finish do not recompose`() {
    val policy = policy(KeyboardProfiles.GBOARD)
    val editor = FakeEditor()
    val echoes = mutableListOf<TextSnapshot>()
    "abc"
      .forEach {
        editor.apply(policy.onText(it.toString(), editor.snapshot()))
        echoes += editor.snapshot()
      }
    editor.apply(policy.finishComposingForAutomation())
    echoes += editor.snapshot()

    echoes.forEach { echo ->
      assertTrue("unexpected ops for $echo", policy.onSelectionChanged(echo).isEmpty())
    }
    editor.setSelection(1)
    assertEquals(
      listOf(ImeOp.SetComposingRegion(0, 3)),
      policy.onSelectionChanged(editor.snapshot()),
    )
  }

  @Test
  fun `samsung recomposition keeps combining marks inside the word`() {
    val policy = policy(KeyboardProfiles.SAMSUNG)
    val editor = FakeEditor("e\u0301x")
    editor.setSelection(2)

    val regionOps = policy.onSelectionChanged(editor.snapshot())
    assertEquals(listOf(ImeOp.SetComposingRegion(0, 3)), regionOps)
    editor.apply(regionOps)

    val insertionOps = policy.onText("y", editor.snapshot())
    editor.apply(insertionOps)
    assertEquals("e\u0301yx", editor.text)
    assertEquals(3, editor.selectionStart)
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
  fun `backspace deletes a complete supplementary character`() {
    val editor = FakeEditor("a😀")
    val ops = policy(KeyboardProfiles.DIRECT).onBackspace(editor.snapshot())

    assertEquals(listOf(ImeOp.DeleteSurroundingText(2, 0)), ops)
    editor.apply(ops)
    assertEquals("a", editor.text)
  }

  @Test
  fun `composition backspace removes a complete supplementary letter`() {
    val policy = policy(KeyboardProfiles.GBOARD)
    val editor = FakeEditor()
    type(policy, editor, "a\uD801\uDC00")

    editor.apply(policy.onBackspace(editor.snapshot()))

    assertEquals("a", editor.text)
    assertEquals(0, editor.composingStart)
    assertEquals(1, editor.composingEnd)
  }

  @Test
  fun `composition backspace removes a complete accented grapheme`() {
    val policy = policy(KeyboardProfiles.GBOARD)
    val editor = FakeEditor()
    type(policy, editor, "e\u0301")

    editor.apply(policy.onBackspace(editor.snapshot()))

    assertEquals("", editor.text)
    assertEquals(-1, editor.composingStart)
  }

  @Test
  fun `committed backspace removes a complete joined emoji grapheme`() {
    val family = "👩‍👩‍👧‍👦"
    val editor = FakeEditor(family)
    val ops = policy(KeyboardProfiles.DIRECT).onBackspace(editor.snapshot())

    assertEquals(listOf(ImeOp.DeleteSurroundingText(family.length, 0)), ops)
    editor.apply(ops)
    assertEquals("", editor.text)
  }

  @Test
  fun `committed backspace removes a complete accented grapheme`() {
    val editor = FakeEditor("be\u0301")
    val ops = policy(KeyboardProfiles.DIRECT).onBackspace(editor.snapshot())

    assertEquals(listOf(ImeOp.DeleteSurroundingText(2, 0)), ops)
    editor.apply(ops)
    assertEquals("b", editor.text)
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

  private fun unicodeCorpus() =
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

  private fun String.hasWellFormedUtf16(): Boolean {
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
