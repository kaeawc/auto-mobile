package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.os.Handler
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30], shadows = [CaretObservingAccessibilityServiceShadow::class])
class CtrlProxyGestureOverloadParityTest {
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
  fun `tap overloads clear caret before framework dispatch`() {
    assertAtomicClearsCaret {
      actions.requestTapCoordinates("legacy", 100.0, 100.0, 10L)
    }
    for (context in listOf(null, fixture.freshFrameContext())) {
      assertAtomicClearsCaret {
        actions.requestTapCoordinates("legacy-frame", 100.0, 100.0, 10L, context)
      }
      for (displayId in listOf(2, 0, null)) {
        assertAtomicClearsCaret {
          actions.requestTapCoordinates("routed", 100.0, 100.0, 10L, context, displayId)
        }
      }
    }
  }

  @Test
  fun `swipe overloads clear caret before framework dispatch`() {
    assertAtomicClearsCaret {
      actions.requestSwipe("legacy", 100.0, 100.0, 200.0, 200.0, 50L)
    }
    for (context in listOf(null, fixture.freshFrameContext())) {
      assertAtomicClearsCaret {
        actions.requestSwipe("legacy-frame", 100.0, 100.0, 200.0, 200.0, 50L, context)
      }
      for (displayId in listOf(2, 0, null)) {
        assertAtomicClearsCaret {
          actions.requestSwipe("routed", 100.0, 100.0, 200.0, 200.0, 50L, context, displayId)
        }
      }
    }
  }

  @Test
  fun `two finger swipe overloads clear caret before framework dispatch`() {
    assertAtomicClearsCaret {
      actions.requestTwoFingerSwipe("legacy", 100.0, 100.0, 200.0, 200.0, 50L, 20)
    }
    for (displayId in listOf(2, 0, null)) {
      assertAtomicClearsCaret {
        actions.requestTwoFingerSwipe("routed", 100.0, 100.0, 200.0, 200.0, 50L, 20, displayId)
      }
    }
  }

  @Test
  fun `drag overloads clear caret before framework dispatch`() {
    assertAtomicClearsCaret {
      actions.requestDrag("legacy", 100.0, 100.0, 200.0, 200.0, 10L, 50L, 10L)
    }
    for (context in listOf(null, fixture.freshFrameContext())) {
      assertAtomicClearsCaret {
        actions.requestDrag("legacy-frame", 100.0, 100.0, 200.0, 200.0, 10L, 50L, 10L, context)
      }
      for (displayId in listOf(2, 0, null)) {
        assertAtomicClearsCaret {
          actions.requestDrag(
            "routed",
            100.0,
            100.0,
            200.0,
            200.0,
            10L,
            50L,
            10L,
            context,
            displayId,
          )
        }
      }
    }
  }

  @Test
  fun `pinch overloads clear caret before framework dispatch`() {
    assertAtomicClearsCaret {
      actions.requestPinch("legacy", 100.0, 100.0, 20.0, 40.0, 30f, 50L)
    }
    for (displayId in listOf(2, 0, null)) {
      assertAtomicClearsCaret {
        actions.requestPinch("routed", 100.0, 100.0, 20.0, 40.0, 30f, 50L, displayId)
      }
    }
  }

  @Test
  fun `legacy gesture start clears caret before framework dispatch`() {
    assertClearsCaret { actions.requestGestureStart("start", "stream", 100.0, 100.0) }
  }

  @Test
  fun `display id gesture start clears caret before framework dispatch`() {
    assertClearsCaret { actions.requestGestureStart("start", "stream", 100.0, 100.0, 2) }
  }

  @Test
  fun `gesture move clears caret before continued framework dispatch`() {
    actions.requestGestureStart("start", "stream", 100.0, 100.0, 2)
    fixture.completeLastStroke()
    assertClearsCaret { actions.requestGestureMove("move", "stream", 150.0, 150.0) }
  }

  @Test
  fun `gesture end clears caret before terminal framework dispatch`() {
    actions.requestGestureStart("start", "stream", 100.0, 100.0, 2)
    fixture.completeLastStroke()
    assertClearsCaret { actions.requestGestureEnd("end", "stream", 200.0, 200.0, false) }
  }

  @Test
  fun `tap frame overloads reject stale context before clearing caret or dispatching`() {
    assertStaleRejected("tap coordinates") { context, displayId, legacy ->
      if (legacy) actions.requestTapCoordinates("stale", 100.0, 100.0, 10L, context)
      else actions.requestTapCoordinates("stale", 100.0, 100.0, 10L, context, displayId)
    }
  }

  @Test
  fun `swipe frame overloads reject stale context before clearing caret or dispatching`() {
    assertStaleRejected("swipe") { context, displayId, legacy ->
      if (legacy) actions.requestSwipe("stale", 100.0, 100.0, 200.0, 200.0, 50L, context)
      else actions.requestSwipe("stale", 100.0, 100.0, 200.0, 200.0, 50L, context, displayId)
    }
  }

  @Test
  fun `drag frame overloads reject stale context before clearing caret or dispatching`() {
    assertStaleRejected("drag") { context, displayId, legacy ->
      if (legacy) {
        actions.requestDrag("stale", 100.0, 100.0, 200.0, 200.0, 10L, 50L, 10L, context)
      } else {
        actions.requestDrag("stale", 100.0, 100.0, 200.0, 200.0, 10L, 50L, 10L, context, displayId)
      }
    }
  }

  private fun assertAtomicClearsCaret(request: () -> Unit) {
    assertClearsCaret(request)
    fixture.cancelLastStroke()
  }

  private fun assertClearsCaret(request: () -> Unit) {
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

  private fun assertStaleRejected(
    resultName: String,
    request: (String, Int?, Boolean) -> Unit,
  ) {
    val stale = fixture.freshFrameContext() + ":stale"
    for ((legacy, displayId) in listOf(true to null, false to 2, false to 0, false to null)) {
      val before = shadow.gesturesDispatched.size
      val observationsBefore = shadow.rememberedAtDispatch.size
      val logsBefore = ShadowLog.getLogs().size
      val sentinel = fixture.seedCaret()
      request(stale, displayId, legacy)
      assertEquals(before, shadow.gesturesDispatched.size)
      assertEquals(observationsBefore, shadow.rememberedAtDispatch.size)
      assertSame(
        "Request-level rejection precedes the shared caret clear",
        sentinel,
        fixture.rememberedCaret(),
      )
      // No listener is started. The inline broadcast's guard still proves the action-specific
      // rejection branch ran, rather than a silent early return. Fresh-context controls above
      // prove these same overloads can dispatch.
      assertTrue(
        ShadowLog.getLogs().drop(logsBefore).any {
          it.msg == "WebSocket server not running, skipping $resultName result broadcast"
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
    rememberedAtDispatch.add(ReflectionHelpers.getField<Any?>(service, "rememberedInsert"))
    return super.dispatchGesture(gesture, callback, handler)
  }
}
