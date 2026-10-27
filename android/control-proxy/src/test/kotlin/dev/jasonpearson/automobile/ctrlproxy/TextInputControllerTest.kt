package dev.jasonpearson.automobile.ctrlproxy

import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction
import android.view.inputmethod.EditorInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.ErrorResponse
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers

/**
 * Pins the behaviour of the text-input paths extracted from CtrlProxy (#11876): set text, insert
 * text, IME actions, select all and the remembered insert caret. The accessibility tree is a
 * stateful fake editable field; the service and WebSocket server are fakes behind the controller's
 * seams.
 */
@RunWith(RobolectricTestRunner::class)
class TextInputControllerTest {
  private class FakeTimer : TimeProvider {
    override fun currentTimeMillis() = 1_000L
  }

  /**
   * A focused editable field. SET_TEXT replaces the text and leaves the caret at the end (as an
   * EditText does); SET_SELECTION moves the caret unless [FieldBehavior.acceptsSelection] is false.
   */
  private data class FieldBehavior(
    val password: Boolean = false,
    val acceptsSetText: Boolean = true,
    val acceptsSelection: Boolean = true,
    val supportedActions: List<AccessibilityAction> =
      listOf(AccessibilityAction.ACTION_SET_TEXT, AccessibilityAction.ACTION_SET_SELECTION),
  )

  private class FakeField(
    var content: String,
    var selectionStart: Int = content.length,
    var selectionEnd: Int = selectionStart,
    val behavior: FieldBehavior = FieldBehavior(),
  ) {
    private val performed = mutableListOf<Int>()
    val node: AccessibilityNodeInfo = mockk(relaxed = true)

    init {
      every { node.text } answers { content }
      every { node.textSelectionStart } answers { selectionStart }
      every { node.textSelectionEnd } answers { selectionEnd }
      every { node.isEditable } returns true
      every { node.isFocused } returns true
      every { node.isPassword } returns behavior.password
      every { node.windowId } returns 7
      every { node.packageName } returns "com.example"
      every { node.className } returns "android.widget.EditText"
      every { node.viewIdResourceName } returns "com.example:id/field"
      every { node.actionList } returns behavior.supportedActions
      every { node.refresh() } returns true
      every { node.performAction(any<Int>()) } answers
        {
          performed += firstArg<Int>()
          true
        }
      every { node.performAction(any<Int>(), any()) } answers { perform(firstArg(), secondArg()) }
    }

    private fun perform(action: Int, args: Bundle?): Boolean {
      performed += action
      return when (action) {
        AccessibilityNodeInfo.ACTION_SET_TEXT -> {
          if (behavior.acceptsSetText) {
            content =
              requireNotNull(args)
                .getCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE)
                .toString()
            selectionStart = content.length
            selectionEnd = content.length
          }
          behavior.acceptsSetText
        }
        AccessibilityNodeInfo.ACTION_SET_SELECTION -> {
          if (behavior.acceptsSelection) {
            val bundle = requireNotNull(args)
            selectionStart =
              bundle.getInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT)
            selectionEnd = bundle.getInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT)
          }
          behavior.acceptsSelection
        }
        else -> true
      }
    }

    fun performedActions(): List<Int> = performed.toList()
  }

  private class FakeHost(
    private val scope: CoroutineScope,
    private val events: MutableList<String>,
  ) : TextInputController.Host {
    var focused: FakeField? = null
    var imeNavigationResult: Boolean? = null
    var keycodeEnterResult = true
    val imeNavigationActions = mutableListOf<Int>()
    var keyboardHidden = false

    override fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit) {
      scope.launch(block = block)
    }

    override fun activeWindowRoot(): AccessibilityNodeInfo? {
      val field = focused ?: return null
      val root: AccessibilityNodeInfo = mockk(relaxed = true)
      every { root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) } returns field.node
      return root
    }

    override fun screenDimensions(displayId: Int): ScreenDimensions? = null

    override fun hideSoftKeyboard() {
      keyboardHidden = true
    }

    override suspend fun performImeNavigationAction(actionId: Int): Boolean? {
      imeNavigationActions += actionId
      return imeNavigationResult
    }

    override fun sendKeycodeEnter(): Boolean {
      events += "keycodeEnter"
      return keycodeEnterResult
    }

    override suspend fun publishSettledHierarchy() {
      events += "publishHierarchy"
    }
  }

  private class FakeSender(private val events: MutableList<String>) : FakeResultTransport() {
    val frames = mutableListOf<Pair<String, JsonObject>>()

    override suspend fun sendFrame(frame: String) {
      val parsed = Json.parseToJsonElement(frame).jsonObject
      val type = parsed.getValue("type").jsonPrimitive.content
      events += "frame:$type"
      frames += type to JsonObject(parsed - setOf("type", "timestamp", "perfTiming"))
    }
  }

  private class Harness(
    val controller: TextInputController,
    val host: FakeHost,
    val sender: FakeSender,
  )

  private val events = mutableListOf<String>()
  private val errors = mutableListOf<ErrorResponse>()
  private var uptimeMs = 10_000L

  private fun TestScope.harness(sdkInt: Int = 30): Harness {
    val host = FakeHost(this, events)
    val sender = FakeSender(events)
    val timer = FakeTimer()
    val controller =
      TextInputController(
        host = host,
        serviceScope = this,
        perfProvider = PerfProvider.createForTesting(timer),
        timeProvider = timer,
        responses =
          TextInputResponseDependencies(
            jsonCompact = Json { encodeDefaults = true },
            resultSender =
              guardedResultSender(
                sender,
                ResultBroadcaster(broadcastError = { errors += it }, logError = { _, _ -> }),
              ),
          ),
        config =
          TextInputConfig(
            uptimeMillis = { uptimeMs },
            pause = { ms -> uptimeMs += ms },
            sdkInt = sdkInt,
          ),
      )
    return Harness(controller, host, sender)
  }

  private fun FakeSender.only(type: String): JsonObject {
    val matching = frames.filter { it.first == type }
    assertEquals("frames of $type in $frames", 1, matching.size)
    return matching.single().second
  }

  private fun JsonObject.bool(key: String) = getValue(key).jsonPrimitive.boolean

  private fun JsonObject.str(key: String) = this[key]?.jsonPrimitive?.content

  private fun TextInputController.remembered(): Any? =
    ReflectionHelpers.getField(this, "rememberedInsert")

  // --- set text ---

  @Test
  fun `set text replaces the focused field and acknowledges before publishing the hierarchy`() =
    runTest {
      val h = harness()
      val field = FakeField("old").also { h.host.focused = it }

      h.controller.performSetText("r1", "new text", resourceId = null, dismissKeyboard = true)
      advanceUntilIdle()

      assertEquals("new text", field.content)
      val frame = h.sender.only("set_text_result")
      assertTrue(frame.bool("success"))
      assertEquals("r1", frame.str("requestId"))
      assertNull(frame["error"])
      assertTrue(h.host.keyboardHidden)
      assertEquals(listOf("frame:set_text_result", "publishHierarchy"), events)
    }

  @Test
  fun `set text without a focused editable field fails without mutating anything`() = runTest {
    val h = harness()

    h.controller.performSetText("r1", "x", resourceId = null)
    advanceUntilIdle()

    val frame = h.sender.only("set_text_result")
    assertFalse(frame.bool("success"))
    assertEquals("No focused editable node found", frame.str("error"))
    assertEquals(listOf("frame:set_text_result"), events)
  }

  @Test
  fun `a rejected set text reports the action failure and skips the hierarchy refresh`() = runTest {
    val h = harness()
    val field =
      FakeField("old", behavior = FieldBehavior(acceptsSetText = false)).also {
        h.host.focused = it
      }

    h.controller.performSetText("r1", "new", resourceId = null, dismissKeyboard = true)
    advanceUntilIdle()

    assertEquals("old", field.content)
    val frame = h.sender.only("set_text_result")
    assertFalse(frame.bool("success"))
    assertEquals("performAction returned false", frame.str("error"))
    assertFalse(h.host.keyboardHidden)
    assertEquals(listOf("frame:set_text_result"), events)
  }

  @Test
  fun `results are dropped while the socket server is not running`() = runTest {
    val h = harness()
    h.host.focused = FakeField("old")
    h.sender.running = false

    h.controller.performSetText("r1", "new", resourceId = null)
    h.controller.performSelectAll("r2")
    advanceUntilIdle()

    assertTrue(h.sender.frames.isEmpty())
    assertTrue(errors.isEmpty())
  }

  // --- insert text ---

  @Test
  fun `insert text replaces the selection and places the caret after the inserted text`() =
    runTest {
      val h = harness()
      val field = FakeField("helloworld", selectionStart = 5).also { h.host.focused = it }

      h.controller.performInsertText(
        "r1",
        "XY",
        expectedSuffix = null,
        acceptsCaretNotPlaced = false,
      )
      advanceUntilIdle()

      assertEquals("helloXYworld", field.content)
      assertEquals(7, field.selectionStart)
      assertEquals(7, field.selectionEnd)
      assertEquals(
        listOf(AccessibilityNodeInfo.ACTION_SET_TEXT, AccessibilityNodeInfo.ACTION_SET_SELECTION),
        field.performedActions(),
      )
      val frame = h.sender.only("insert_text_result")
      assertTrue(frame.bool("success"))
      assertNull(frame["partialApplication"])
      assertEquals(listOf("frame:insert_text_result", "publishHierarchy"), events)
      assertNull(h.controller.remembered())
    }

  @Test
  fun `insert text refuses a password field without reading or writing it`() = runTest {
    val h = harness()
    val field =
      FakeField("secret", behavior = FieldBehavior(password = true)).also { h.host.focused = it }

    h.controller.performInsertText("r1", "x", expectedSuffix = null, acceptsCaretNotPlaced = false)
    advanceUntilIdle()

    assertEquals("secret", field.content)
    assertTrue(field.performedActions().isEmpty())
    val frame = h.sender.only("insert_text_result")
    assertFalse(frame.bool("success"))
    assertEquals(
      "Cannot insert text into a password field without exposing its original value",
      frame.str("error"),
    )
  }

  @Test
  fun `insert text without a focused editable field fails`() = runTest {
    val h = harness()

    h.controller.performInsertText("r1", "x", expectedSuffix = null, acceptsCaretNotPlaced = false)
    advanceUntilIdle()

    val frame = h.sender.only("insert_text_result")
    assertFalse(frame.bool("success"))
    assertEquals("No focused editable node found", frame.str("error"))
  }

  @Test
  fun `insert text checks selection support before mutating the field`() = runTest {
    val h = harness()
    val field =
      FakeField(
          "abc",
          behavior = FieldBehavior(supportedActions = listOf(AccessibilityAction.ACTION_SET_TEXT)),
        )
        .also {
          h.host.focused = it
        }

    h.controller.performInsertText("r1", "x", expectedSuffix = null, acceptsCaretNotPlaced = false)
    advanceUntilIdle()

    assertEquals("abc", field.content)
    val frame = h.sender.only("insert_text_result")
    assertFalse(frame.bool("success"))
    assertEquals("Focused editable node does not support ACTION_SET_SELECTION", frame.str("error"))
    assertEquals(listOf("frame:insert_text_result"), events)
  }

  @Test
  fun `a rejected caret placement is a partial application unless the caller accepts it`() =
    runTest {
      val h = harness()
      val field =
        FakeField("ab", selectionStart = 1, behavior = FieldBehavior(acceptsSelection = false))
          .also { h.host.focused = it }

      h.controller.performInsertText(
        "r1",
        "X",
        expectedSuffix = null,
        acceptsCaretNotPlaced = false,
      )
      advanceUntilIdle()

      assertEquals("aXb", field.content)
      val frame = h.sender.only("insert_text_result")
      assertFalse(frame.bool("success"))
      assertTrue(frame.bool("partialApplication"))
      assertEquals(
        "Text was inserted, but ACTION_SET_SELECTION returned false; do not retry",
        frame.str("error"),
      )
      // The field still changed, so its hierarchy is refreshed after the acknowledgement.
      assertEquals(listOf("frame:insert_text_result", "publishHierarchy"), events)
      assertNull(h.controller.remembered())
    }

  @Test
  fun `an accepted unplaced caret is remembered and the next insert continues from it`() = runTest {
    val h = harness()
    // Compose-like: the caret stays at the end after SET_TEXT and SET_SELECTION is ignored.
    val field =
      FakeField("ab", selectionStart = 1, behavior = FieldBehavior(acceptsSelection = false)).also {
        h.host.focused = it
      }

    h.controller.performInsertText("r1", "X", expectedSuffix = null, acceptsCaretNotPlaced = true)
    advanceUntilIdle()

    val first = h.sender.only("insert_text_result")
    assertTrue(first.bool("success"))
    assertFalse(first.bool("caretPlaced"))
    assertEquals(3, first.getValue("resultingTextLength").jsonPrimitive.int)
    assertNotNull(h.controller.remembered())

    h.controller.performInsertText("r2", "Y", expectedSuffix = null, acceptsCaretNotPlaced = true)
    advanceUntilIdle()

    // The reported selection (end of text) is ignored in favour of the remembered caret.
    assertEquals("aXYb", field.content)
  }

  @Test
  fun `a selection change away from the remembered caret forgets it`() = runTest {
    val h = harness()
    h.host.focused =
      FakeField("ab", selectionStart = 1, behavior = FieldBehavior(acceptsSelection = false))
    h.controller.performInsertText("r1", "X", expectedSuffix = null, acceptsCaretNotPlaced = true)
    advanceUntilIdle()
    assertNotNull(h.controller.remembered())

    // The reported selection after the insert is the end of "aXb"; a matching event keeps it.
    h.controller.onTextSelectionChanged(3, 3)
    assertNotNull(h.controller.remembered())

    h.controller.onTextSelectionChanged(0, 0)
    assertNull(h.controller.remembered())
  }

  @Test
  fun `set text ime action and select all each forget the remembered caret`() = runTest {
    val h = harness()
    val sentinel = Unit to Unit
    h.host.focused = FakeField("abc")

    ReflectionHelpers.setField(h.controller, "rememberedInsert", sentinel)
    h.controller.performSetText("r1", "x", resourceId = null)
    assertNull(h.controller.remembered())

    ReflectionHelpers.setField(h.controller, "rememberedInsert", sentinel)
    h.controller.performImeAction("r2", "unknown")
    assertNull(h.controller.remembered())

    ReflectionHelpers.setField(h.controller, "rememberedInsert", sentinel)
    h.controller.performSelectAll("r3")
    assertNull(h.controller.remembered())

    ReflectionHelpers.setField(h.controller, "rememberedInsert", sentinel)
    h.controller.forgetRememberedInsert()
    assertNull(h.controller.remembered())
    advanceUntilIdle()
  }

  @Test
  fun `insert text state reports the focused field snapshot`() = runTest {
    val h = harness()
    h.host.focused = FakeField("hello", selectionStart = 2, selectionEnd = 4)

    h.controller.handleInsertTextState("r1")
    advanceUntilIdle()

    val frame = h.sender.only("insert_text_state_result")
    assertTrue(frame.bool("success"))
    val state = frame.getValue("state").jsonObject
    assertEquals("hello", state.str("text"))
  }

  @Test
  fun `insert text state omits the snapshot for a password field`() = runTest {
    val h = harness()
    h.host.focused = FakeField("secret", behavior = FieldBehavior(password = true))

    h.controller.handleInsertTextState("r1")
    advanceUntilIdle()

    val frame = h.sender.only("insert_text_state_result")
    assertTrue(frame.bool("success"))
    assertNull(frame["state"])
  }

  // --- IME actions ---

  @Test
  fun `next goes through the IME connection when one is available`() = runTest {
    val h = harness()
    h.host.focused = FakeField("abc")
    h.host.imeNavigationResult = true

    h.controller.performImeAction("r1", "next")
    advanceUntilIdle()

    assertEquals(listOf(EditorInfo.IME_ACTION_NEXT), h.host.imeNavigationActions)
    val frame = h.sender.only("ime_action_result")
    assertTrue(frame.bool("success"))
    assertEquals("next", frame.str("action"))
    assertNull(frame["approximated"])
    // IME actions settle the hierarchy before acknowledging.
    assertEquals(listOf("publishHierarchy", "frame:ime_action_result"), events)
  }

  @Test
  fun `next without an IME connection or focused field fails`() = runTest {
    val h = harness()

    h.controller.performImeAction("r1", "next")
    advanceUntilIdle()

    val frame = h.sender.only("ime_action_result")
    assertFalse(frame.bool("success"))
    assertEquals("No focused editable node found for IME action", frame.str("error"))
    assertEquals(listOf("frame:ime_action_result"), events)
  }

  @Test
  fun `next without an IME connection is approximated by focus traversal`() = runTest {
    val h = harness()
    h.host.focused = FakeField("abc")

    h.controller.performImeAction("r1", "next")
    advanceUntilIdle()

    // The fake root has no next focusable node, so traversal fails but is reported approximated.
    val frame = h.sender.only("ime_action_result")
    assertFalse(frame.bool("success"))
    assertEquals("Action failed", frame.str("error"))
    assertTrue(frame.bool("approximated"))
  }

  @Test
  @Config(sdk = [30])
  fun `done performs ACTION_IME_ENTER on the focused field from API 30`() = runTest {
    val h = harness(sdkInt = 30)
    val field = FakeField("abc").also { h.host.focused = it }

    h.controller.performImeAction("r1", "done")
    advanceUntilIdle()

    assertEquals(listOf(AccessibilityAction.ACTION_IME_ENTER.id), field.performedActions())
    assertTrue(h.sender.only("ime_action_result").bool("success"))
  }

  @Test
  @Config(sdk = [24, 29])
  fun `done falls back to KEYCODE_ENTER before API 30`() = runTest {
    val h = harness(sdkInt = 29)
    h.host.focused = FakeField("abc")
    h.host.keycodeEnterResult = false

    h.controller.performImeAction("r1", "search")
    advanceUntilIdle()

    assertEquals(listOf("keycodeEnter", "frame:ime_action_result"), events)
    val frame = h.sender.only("ime_action_result")
    assertFalse(frame.bool("success"))
    assertEquals("Action failed", frame.str("error"))
  }

  // --- select all ---

  @Test
  fun `select all selects the whole field`() = runTest {
    val h = harness()
    val field = FakeField("hello", selectionStart = 0).also { h.host.focused = it }

    h.controller.performSelectAll("r1")

    assertEquals(0, field.selectionStart)
    assertEquals(5, field.selectionEnd)
    assertTrue(h.sender.only("select_all_result").bool("success"))
  }

  @Test
  fun `select all on an already selected field succeeds without an action`() = runTest {
    val h = harness()
    val field =
      FakeField("hello", selectionStart = 0, selectionEnd = 5).also { h.host.focused = it }

    h.controller.performSelectAll("r1")

    assertTrue(field.performedActions().isEmpty())
    assertTrue(h.sender.only("select_all_result").bool("success"))
  }

  @Test
  fun `a rejected select all that did not select the text fails`() = runTest {
    val h = harness()
    h.host.focused =
      FakeField("hello", selectionStart = 2, behavior = FieldBehavior(acceptsSelection = false))

    h.controller.performSelectAll("r1")

    val frame = h.sender.only("select_all_result")
    assertFalse(frame.bool("success"))
    assertEquals("performAction returned false", frame.str("error"))
  }

  @Test
  fun `select all without a focused editable field fails`() = runTest {
    val h = harness()

    h.controller.performSelectAll("r1")

    val frame = h.sender.only("select_all_result")
    assertFalse(frame.bool("success"))
    assertEquals("No focused editable node found", frame.str("error"))
  }
}
