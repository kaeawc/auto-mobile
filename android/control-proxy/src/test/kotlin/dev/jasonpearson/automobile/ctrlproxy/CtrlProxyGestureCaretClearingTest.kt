package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.os.Handler
import dev.jasonpearson.automobile.protocol.RequestDrag
import dev.jasonpearson.automobile.protocol.RequestGestureStart
import dev.jasonpearson.automobile.protocol.RequestPinch
import dev.jasonpearson.automobile.protocol.RequestSwipe
import dev.jasonpearson.automobile.protocol.RequestTapCoordinates
import dev.jasonpearson.automobile.protocol.RequestTwoFingerSwipe
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.RealObject
import org.robolectric.shadows.ShadowAccessibilityService
import org.robolectric.shadows.ShadowLog
import org.robolectric.util.ReflectionHelpers

/**
 * Every gesture action clears the text caret before the framework dispatches it.
 *
 * This was the overload-parity test that policed `CtrlProxyActions`' default-method overload
 * ladders. Those are gone (#11878): each action takes one typed request, so the parity hazard no
 * longer exists and only the caret behavior is left to pin.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30], shadows = [CaretObservingAccessibilityServiceShadow::class])
class CtrlProxyGestureCaretClearingTest {
  private lateinit var fixture: CtrlProxyGestureServiceFixture
  private val actions: CtrlProxyActions
    get() = fixture.actions

  private val shadow: CaretObservingAccessibilityServiceShadow
    get() = fixture.shadow as CaretObservingAccessibilityServiceShadow

  @Before
  fun setUp() {
    fixture = CtrlProxyGestureServiceFixture()
  }

  @After
  fun tearDown() {
    fixture.close()
  }

  @Test
  fun `tap requests clear caret before framework dispatch`() = runTest {
    for (context in listOf(null, fixture.freshFrameContext())) {
      for (displayId in listOf(2, 0, null)) {
        assertAtomicClearsCaret {
          actions.requestTapCoordinates(
            RequestTapCoordinates(
              requestId = "routed",
              x = 100.0,
              y = 100.0,
              duration = 10L,
              frameContext = context,
              displayId = displayId,
            ),
          )
        }
      }
    }
  }

  @Test
  fun `swipe requests clear caret before framework dispatch`() = runTest {
    for (context in listOf(null, fixture.freshFrameContext())) {
      for (displayId in listOf(2, 0, null)) {
        assertAtomicClearsCaret {
          actions.requestSwipe(
            RequestSwipe(
              requestId = "routed",
              x1 = 100.0,
              y1 = 100.0,
              x2 = 200.0,
              y2 = 200.0,
              duration = 50L,
              frameContext = context,
              displayId = displayId,
            ),
          )
        }
      }
    }
  }

  @Test
  fun `two finger swipe requests clear caret before framework dispatch`() = runTest {
    for (displayId in listOf(2, 0, null)) {
      assertAtomicClearsCaret {
        actions.requestTwoFingerSwipe(
          RequestTwoFingerSwipe(
            requestId = "routed",
            x1 = 100.0,
            y1 = 100.0,
            x2 = 200.0,
            y2 = 200.0,
            duration = 50L,
            offset = 20,
            displayId = displayId,
          ),
        )
      }
    }
  }

  @Test
  fun `drag requests clear caret before framework dispatch`() = runTest {
    for (context in listOf(null, fixture.freshFrameContext())) {
      for (displayId in listOf(2, 0, null)) {
        assertAtomicClearsCaret {
          actions.requestDrag(
            RequestDrag(
              requestId = "routed",
              x1 = 100.0,
              y1 = 100.0,
              x2 = 200.0,
              y2 = 200.0,
              pressDurationMs = 10L,
              dragDurationMs = 50L,
              holdDurationMs = 10L,
              frameContext = context,
              displayId = displayId,
            ),
          )
        }
      }
    }
  }

  @Test
  fun `pinch requests clear caret before framework dispatch`() = runTest {
    for (displayId in listOf(2, 0, null)) {
      assertAtomicClearsCaret {
        actions.requestPinch(
          RequestPinch(
            requestId = "routed",
            centerX = 100.0,
            centerY = 100.0,
            distanceStart = 20.0,
            distanceEnd = 40.0,
            rotationDegrees = 30f,
            duration = 50L,
            displayId = displayId,
          ),
        )
      }
    }
  }

  @Test
  fun `default display gesture start clears caret before framework dispatch`() = runTest {
    assertClearsCaret {
      actions.requestGestureStart(
        RequestGestureStart(requestId = "start", gestureId = "stream", x = 100.0, y = 100.0),
      )
    }
  }

  @Test
  fun `display id gesture start clears caret before framework dispatch`() = runTest {
    assertClearsCaret {
      actions.requestGestureStart(
        RequestGestureStart(
          requestId = "start",
          gestureId = "stream",
          x = 100.0,
          y = 100.0,
          displayId = 2,
        ),
      )
    }
  }

  @Test
  fun `gesture move clears caret before continued framework dispatch`() = runTest {
    actions.requestGestureStart(
      RequestGestureStart(
        requestId = "start",
        gestureId = "stream",
        x = 100.0,
        y = 100.0,
        displayId = 2,
      ),
    )
    fixture.completeLastStroke()
    assertClearsCaret { actions.requestGestureMove("move", "stream", 150.0, 150.0) }
  }

  @Test
  fun `gesture end clears caret before terminal framework dispatch`() = runTest {
    actions.requestGestureStart(
      RequestGestureStart(
        requestId = "start",
        gestureId = "stream",
        x = 100.0,
        y = 100.0,
        displayId = 2,
      ),
    )
    fixture.completeLastStroke()
    assertClearsCaret { actions.requestGestureEnd("end", "stream", 200.0, 200.0, false) }
  }

  @Test
  fun `tap requests reject stale context before clearing caret or dispatching`() = runTest {
    assertStaleRejected("tap_coordinates_result") { context, displayId ->
      actions.requestTapCoordinates(
        RequestTapCoordinates("stale", 100.0, 100.0, 10L, context, displayId),
      )
    }
  }

  @Test
  fun `swipe requests reject stale context before clearing caret or dispatching`() = runTest {
    assertStaleRejected("swipe_result") { context, displayId ->
      actions.requestSwipe(
        RequestSwipe("stale", 100.0, 100.0, 200.0, 200.0, 50L, context, displayId),
      )
    }
  }

  @Test
  fun `drag requests reject stale context before clearing caret or dispatching`() = runTest {
    assertStaleRejected("drag_result") { context, displayId ->
      actions.requestDrag(
        RequestDrag(
          requestId = "stale",
          x1 = 100.0,
          y1 = 100.0,
          x2 = 200.0,
          y2 = 200.0,
          pressDurationMs = 10L,
          dragDurationMs = 50L,
          holdDurationMs = 10L,
          frameContext = context,
          displayId = displayId,
        ),
      )
    }
  }

  private suspend fun assertAtomicClearsCaret(request: suspend () -> Unit) {
    assertClearsCaret(request)
    fixture.cancelLastStroke()
  }

  private suspend fun assertClearsCaret(request: suspend () -> Unit) {
    val before = shadow.gesturesDispatched.size
    val observationsBefore = shadow.rememberedAtDispatch.size
    val sentinel = fixture.seedCaret()
    assertSame(sentinel, fixture.rememberedCaret())
    request()
    assertEquals(before + 1, shadow.gesturesDispatched.size)
    assertEquals(observationsBefore + 1, shadow.rememberedAtDispatch.size)
    assertNull(
      "Caret must already be cleared when dispatchGesture is entered",
      shadow.rememberedAtDispatch.last(),
    )
    assertNull(fixture.rememberedCaret())
  }

  private suspend fun assertStaleRejected(
    resultName: String,
    request: suspend (String, Int?) -> Unit,
  ) {
    val stale = fixture.freshFrameContext() + ":stale"
    for (displayId in listOf(2, 0, null)) {
      val before = shadow.gesturesDispatched.size
      val observationsBefore = shadow.rememberedAtDispatch.size
      val logsBefore = ShadowLog.getLogs().size
      val sentinel = fixture.seedCaret()
      request(stale, displayId)
      assertEquals(before, shadow.gesturesDispatched.size)
      assertEquals(observationsBefore, shadow.rememberedAtDispatch.size)
      assertSame(
        "Request-level rejection precedes the shared caret clear",
        sentinel,
        fixture.rememberedCaret(),
      )
      // No listener is started. The inline broadcast's guard still proves the action-specific
      // rejection branch ran, rather than a silent early return. Fresh-context controls above
      // prove these same requests can dispatch.
      assertTrue(
        ShadowLog.getLogs().drop(logsBefore).any {
          it.msg == "WebSocket server not running, skipping $resultName"
        },
      )
    }
  }
}

/** Observe entry to the standard dispatch shadow, then retain its normal recording/callback API. */
@Implements(AccessibilityService::class)
class CaretObservingAccessibilityServiceShadow : ShadowAccessibilityService() {
  @RealObject private lateinit var service: AccessibilityService
  val rememberedAtDispatch = mutableListOf<Any?>()

  @Implementation
  override fun dispatchGesture(
    gesture: GestureDescription,
    callback: AccessibilityService.GestureResultCallback?,
    handler: Handler?,
  ): Boolean {
    val textInput = ReflectionHelpers.getField<TextInputController>(service, "textInputController")
    rememberedAtDispatch.add(ReflectionHelpers.getField<Any?>(textInput, "rememberedInsert"))
    return super.dispatchGesture(gesture, callback, handler)
  }
}
