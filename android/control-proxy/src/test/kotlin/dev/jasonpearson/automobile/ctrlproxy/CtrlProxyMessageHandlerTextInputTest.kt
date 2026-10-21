package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ImeTextDelivery
import dev.jasonpearson.automobile.protocol.RequestCommitText
import dev.jasonpearson.automobile.protocol.RequestImeAction
import dev.jasonpearson.automobile.protocol.RequestInsertText
import dev.jasonpearson.automobile.protocol.RequestSetText
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

internal class CtrlProxyMessageHandlerTextInputTest : CtrlProxyMessageHandlerFixtures() {
  @Test
  fun `dispatches IME trace opt in and delegates the typed request`() = runTest {
    val traceFlags = mutableListOf<Boolean>()
    val tracedActions =
      object : CtrlProxyActions by actions {
        override suspend fun requestCommitText(request: RequestCommitText) {
          traceFlags.add(request.trace)
          actions.requestCommitText(request)
        }
      }
    val tracedHandler = CtrlProxyMessageHandler(tracedActions)
    for (suffix in listOf("", ",\"trace\":true")) {
      tracedHandler.handleMessage(
        json.decodeFromString<WebSocketRequest>(
          """{"type":"request_commit_text","text":"value"$suffix}""",
        ),
      )
    }
    assertEquals(listOf(false, true), traceFlags)
    assertEquals(
      "requestCommitText" to
        listOf<Any?>(
          RequestCommitText(
            requestId = null,
            text = "value",
            priorImeId = null,
            delivery = ImeTextDelivery.COMMIT,
            timeoutMs = null,
            trace = true,
          ),
        ),
      lastCall,
    )
  }

  // ---------------------------------------------------------------------------
  // Text input / actions
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches request_set_text`() = runTest {
    dispatch(
      """{"type":"request_set_text","requestId":"txt1","text":"Hello","resourceId":"field","dismissKeyboard":true}""",
    )
    assertEquals(
      "requestSetText" to
        listOf<Any?>(
          RequestSetText(
            requestId = "txt1",
            text = "Hello",
            resourceId = "field",
            dismissKeyboard = true,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `forwards frame context with request_set_text`() = runTest {
    dispatch(
      """{"type":"request_set_text","requestId":"txt1","text":"Hello","frameContext":"frame-1"}""",
    )
    assertEquals(
      "requestSetText" to
        listOf<Any?>(
          RequestSetText(
            requestId = "txt1",
            text = "Hello",
            resourceId = null,
            dismissKeyboard = false,
            frameContext = "frame-1",
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `framed set text dispatch preserves resource and keyboard arguments`() = runTest {
    assertTypedDispatch(
      """{"type":"request_set_text","requestId":"framed-text","text":"Hello","resourceId":"field","dismissKeyboard":true,"frameContext":"frame-text"}""",
      "requestSetText" to
        listOf<Any?>(
          RequestSetText(
            requestId = "framed-text",
            text = "Hello",
            resourceId = "field",
            dismissKeyboard = true,
            frameContext = "frame-text",
          ),
        ),
    )
  }

  @Test
  fun `request_insert_text with expectedSuffix routes the capability call`() = runTest {
    dispatch("""{"type":"request_insert_text","requestId":"id","text":"t","expectedSuffix":"ab"}""")
    assertEquals(
      "requestInsertText" to
        listOf<Any?>(
          RequestInsertText(
            requestId = "id",
            text = "t",
            expectedSuffix = "ab",
            acceptsCaretNotPlaced = false,
            precedingState = null,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `dispatches opted in request_insert_text`() = runTest {
    dispatch(
      """{"type":"request_insert_text","requestId":"id","text":"t","acceptsCaretNotPlaced":true}""",
    )
    assertEquals(
      "requestInsertText" to
        listOf<Any?>(
          RequestInsertText(
            requestId = "id",
            text = "t",
            expectedSuffix = null,
            acceptsCaretNotPlaced = true,
            precedingState = null,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_insert_text`() = runTest {
    dispatch("""{"type":"request_insert_text","requestId":"txt2","text":" world"}""")
    assertEquals(
      "requestInsertText" to
        listOf<Any?>(
          RequestInsertText(
            requestId = "txt2",
            text = " world",
            expectedSuffix = null,
            acceptsCaretNotPlaced = false,
            precedingState = null,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `insert text dispatch preserves all capability arguments together`() = runTest {
    assertTypedDispatch(
      """{"type":"request_insert_text","requestId":"insert","text":"😀","expectedSuffix":"x","acceptsCaretNotPlaced":true,"precedingState":{"text":"éx","isShowingHintText":true,"selectionStart":1,"selectionEnd":2}}""",
      "requestInsertText" to
        listOf<Any?>(
          RequestInsertText(
            requestId = "insert",
            text = "😀",
            expectedSuffix = "x",
            acceptsCaretNotPlaced = true,
            precedingState = dev.jasonpearson.automobile.protocol.InsertTextState("éx", true, 1, 2),
          ),
        ),
    )
  }

  @Test
  fun `dispatches pre-dispatch state read`() = runTest {
    dispatch("""{"type":"request_insert_text_state","requestId":"baseline"}""")
    assertEquals("requestInsertTextState" to listOf<Any?>("baseline"), lastCall)
  }

  @Test
  fun `dispatches optional pre-dispatch baseline`() = runTest {
    dispatch(
      """{"type":"request_insert_text","text":"😀","expectedSuffix":"x","precedingState":{"text":"éx","selectionStart":2,"selectionEnd":2}}""",
    )
    assertEquals(
      dev.jasonpearson.automobile.protocol.InsertTextState("éx", false, 2, 2),
      (lastCall.second.single() as RequestInsertText).precedingState,
    )
  }

  @Test
  fun `dispatches the optional IME commit budget`() = runTest {
    dispatch(
      """{"type":"request_commit_text","requestId":"commit-1","text":"long text","timeoutMs":14500}""",
    )
    assertEquals(
      "requestCommitText" to
        listOf<Any?>(
          RequestCommitText(
            requestId = "commit-1",
            text = "long text",
            priorImeId = null,
            delivery = ImeTextDelivery.COMMIT,
            timeoutMs = 14_500L,
          ),
        ),
      lastCall,
    )
    dispatch("""{"type":"request_commit_text","requestId":"commit-2","text":"short"}""")
    assertEquals(
      "requestCommitText" to
        listOf<Any?>(
          RequestCommitText(
            requestId = "commit-2",
            text = "short",
            priorImeId = null,
            delivery = ImeTextDelivery.COMMIT,
            timeoutMs = null,
          ),
        ),
      lastCall,
    )
    dispatch(
      """{"type":"request_commit_text","requestId":"commit-3","text":"abc","delivery":"keyEvents","timeoutMs":9000}""",
    )
    assertEquals(
      "requestCommitText" to
        listOf<Any?>(
          RequestCommitText(
            requestId = "commit-3",
            text = "abc",
            priorImeId = null,
            delivery = ImeTextDelivery.KEY_EVENTS,
            timeoutMs = 9_000L,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `commit text dispatch preserves delivery budget prior IME and trace together`() = runTest {
    for ((wireDelivery, delivery) in
      listOf(
        "commit" to ImeTextDelivery.COMMIT,
        "keyEvents" to ImeTextDelivery.KEY_EVENTS,
        "clearField" to ImeTextDelivery.CLEAR_FIELD,
      )) {
      for (timeout in listOf(null, 9000L)) {
        for (trace in listOf(false, true)) {
          assertTypedDispatch(
            """{"type":"request_commit_text","requestId":"commit","text":"value","priorImeId":"prior/ime","delivery":"$wireDelivery","timeoutMs":$timeout,"trace":$trace}""",
            "requestCommitText" to
              listOf<Any?>(
                RequestCommitText(
                  requestId = "commit",
                  text = "value",
                  priorImeId = "prior/ime",
                  delivery = delivery,
                  timeoutMs = timeout,
                  trace = trace,
                ),
              ),
          )
        }
      }
    }
    assertTypedDispatch(
      """{"type":"request_commit_text","text":"value"}""",
      "requestCommitText" to
        listOf<Any?>(
          RequestCommitText(
            requestId = null,
            text = "value",
            priorImeId = null,
            delivery = ImeTextDelivery.COMMIT,
            timeoutMs = null,
            trace = false,
          ),
        ),
    )
  }

  @Test
  fun `dispatches correlated IME cancellation`() = runTest {
    dispatch(
      """{"type":"request_cancel_ime_commit","requestId":"cancel-1","targetRequestId":"commit-1"}""",
    )
    assertEquals("requestCancelImeCommit" to listOf<Any?>("cancel-1", "commit-1"), lastCall)
  }

  @Test
  fun `dispatches request_set_keyboard_profile`() = runTest {
    dispatch(
      """{"type":"request_set_keyboard_profile","requestId":"profile-1","profileId":"gboard"}""",
    )
    assertEquals("requestSetKeyboardProfile" to listOf<Any?>("profile-1", "gboard"), lastCall)
  }

  @Test
  fun `dispatches request_list_keyboard_profiles with supported versions`() = runTest {
    dispatch(
      """{"type":"request_list_keyboard_profiles","requestId":"profiles-1","supportedCatalogVersions":[1]}""",
    )
    assertEquals("requestListKeyboardProfiles" to listOf<Any?>("profiles-1", listOf(1)), lastCall)
  }

  @Test
  fun `dispatches request_ime_action`() = runTest {
    dispatch("""{"type":"request_ime_action","requestId":"i1","action":"search"}""")
    assertEquals(
      "requestImeAction" to listOf<Any?>(RequestImeAction(requestId = "i1", action = "search")),
      lastCall,
    )
  }

  @Test
  fun `forwards frame context with request_ime_action`() = runTest {
    dispatch(
      """{"type":"request_ime_action","requestId":"i1","action":"search","frameContext":"frame-1"}""",
    )
    assertEquals(
      "requestImeAction" to
        listOf<Any?>(
          RequestImeAction(requestId = "i1", action = "search", frameContext = "frame-1"),
        ),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_click_focused_input`() = runTest {
    dispatch("""{"type":"request_click_focused_input","requestId":"fc1"}""")
    assertEquals("requestClickFocusedInput" to listOf<Any?>("fc1"), lastCall)
  }

  @Test
  fun `dispatches request_select_all`() = runTest {
    dispatch("""{"type":"request_select_all","requestId":"sa1"}""")
    assertEquals("requestSelectAll" to listOf<Any?>("sa1"), lastCall)
  }

  @Test
  fun `dispatches request_action`() = runTest {
    dispatch(
      """{"type":"request_action","requestId":"a1","action":"long_click","resourceId":"com.app:id/x"}""",
    )
    assertEquals(
      "requestAction" to
        listOf<Any?>("a1", "long_click", "com.app:id/x", null, NodeActionArguments()),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_action arguments for custom and set_progress`() = runTest {
    dispatch(
      """{"type":"request_action","requestId":"a3","action":"custom","resourceId":"com.app:id/row","customAction":"Archive"}""",
    )
    assertEquals(
      "requestAction" to
        listOf<Any?>(
          "a3",
          "custom",
          "com.app:id/row",
          null,
          NodeActionArguments(customAction = "Archive"),
        ),
      lastCall,
    )
    dispatch(
      """{"type":"request_action","requestId":"a4","action":"set_progress","resourceId":"com.app:id/slider","progress":0.75}""",
    )
    assertEquals(
      "requestAction" to
        listOf<Any?>(
          "a4",
          "set_progress",
          "com.app:id/slider",
          null,
          NodeActionArguments(progress = 0.75f),
        ),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_action selector`() = runTest {
    dispatch(
      """{"type":"request_action","requestId":"a2","action":"long_click","selector":{"testTag":"message_row_42","collectionRow":4,"collectionColumn":0}}""",
    )
    assertEquals(
      "requestAction" to
        listOf<Any?>(
          "a2",
          "long_click",
          null,
          dev.jasonpearson.automobile.protocol.NodeSelector(
            testTag = "message_row_42",
            collectionRow = 4,
            collectionColumn = 0,
          ),
          NodeActionArguments(),
        ),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_clipboard`() = runTest {
    dispatch("""{"type":"request_clipboard","requestId":"c1","action":"copy","text":"hi"}""")
    assertEquals("requestClipboard" to listOf<Any?>("c1", "copy", "hi"), lastCall)
  }
}
