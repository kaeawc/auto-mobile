package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityWindowInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OwnWindowTypeMemoTest {
  private val own = "dev.jasonpearson.automobile.ctrlproxy"

  @Test
  fun `overlay burst resolves once and interleaved foreign events do no work`() {
    var resolutions = 0
    var stateReads = 0
    var clockReads = 0
    val memo =
      OwnWindowTypeMemo(
        nowMs = {
          clockReads++
          0L
        },
      )
    val resolve = {
      resolutions++
      AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY
    }
    val showing = {
      stateReads++
      true
    }
    repeat(BURST_COUNT) {
      assertTrue(ownWindowEventDecision(own, own, OWN_WINDOW_ID, memo, showing, resolve).skip)
      for (foreign in listOf("com.example.app", null)) {
        assertEquals(
          OwnWindowEventDecision(false, null),
          ownWindowEventDecision(foreign, own, FOREIGN_WINDOW_ID, memo, showing, resolve),
        )
      }
    }
    // Previously 100 resolutions = 200 binder calls; now 1 resolution = 2 binder calls.
    assertEquals(1, resolutions)
    assertEquals(0, stateReads)
    assertEquals(BURST_COUNT, clockReads)
    var foreignResolutions = 0
    assertNull(
      memo.windowType(FOREIGN_WINDOW_ID) {
        foreignResolutions++
        null
      }
    )
    assertEquals(1, foreignResolutions) // Foreign events did not populate this id.
  }

  @Test
  fun `unknown windows retry only at the interval and later success is cached`() {
    var now = 0L
    var resolutions = 0
    var type: Int? = null
    val memo = OwnWindowTypeMemo(nowMs = { now })
    val resolve = {
      resolutions++
      type
    }
    repeat(BURST_COUNT) {
      assertFalse(ownWindowEventDecision(own, own, OWN_WINDOW_ID, memo, { true }, resolve).skip)
      now++
    }
    assertEquals(1, resolutions) // 0 through 99 ms occupy one 250 ms retry window.
    now = RETRY_MS - 1
    assertNull(memo.windowType(OWN_WINDOW_ID, resolve))
    assertEquals(1, resolutions)
    now = RETRY_MS
    assertNull(memo.windowType(OWN_WINDOW_ID, resolve))
    assertEquals(2, resolutions)
    type = AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY
    now = RETRY_MS * 2 - 1
    assertFalse(ownWindowEventDecision(own, own, OWN_WINDOW_ID, memo, { true }, resolve).skip)
    now++
    repeat(BURST_COUNT) {
      assertTrue(ownWindowEventDecision(own, own, OWN_WINDOW_ID, memo, { true }, resolve).skip)
      now++
    }
    assertEquals(EXPECTED_RETRY_RESOLUTIONS, resolutions)
  }

  @Test
  fun `keyboard and activity windows are cached and always processed`() {
    for (type in
      listOf(
        AccessibilityWindowInfo.TYPE_INPUT_METHOD,
        AccessibilityWindowInfo.TYPE_APPLICATION,
      )) {
      val memo = OwnWindowTypeMemo(nowMs = { 0L })
      var resolutions = 0
      var stateReads = 0
      for (showing in listOf(false, true)) {
        repeat(BURST_COUNT) {
          val decision =
            ownWindowEventDecision(
              own,
              own,
              OWN_WINDOW_ID,
              memo,
              {
                stateReads++
                showing
              },
            ) {
              resolutions++
              type
            }
          assertFalse(decision.skip)
          assertEquals(type, decision.windowType)
        }
      }
      assertEquals(1, resolutions)
      assertEquals(0, stateReads)
    }
  }

  @Test
  fun `system window reads live app layer state on every event`() {
    val memo = OwnWindowTypeMemo(nowMs = { 0L })
    var resolutions = 0
    var stateReads = 0
    var showing = false
    val state = {
      stateReads++
      showing
    }
    val resolve = {
      resolutions++
      AccessibilityWindowInfo.TYPE_SYSTEM
    }
    assertFalse(ownWindowEventDecision(own, own, OWN_WINDOW_ID, memo, state, resolve).skip)
    showing = true
    assertTrue(ownWindowEventDecision(own, own, OWN_WINDOW_ID, memo, state, resolve).skip)
    showing = false
    assertFalse(ownWindowEventDecision(own, own, OWN_WINDOW_ID, memo, state, resolve).skip)
    assertEquals(1, resolutions)
    assertEquals(SYSTEM_EVENT_COUNT, stateReads)
  }

  @Test
  fun `clear resolves reused id and honours its changed type`() {
    val memo = OwnWindowTypeMemo(nowMs = { 0L })
    var resolutions = 0
    var type = AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY
    val resolve = {
      resolutions++
      type
    }
    assertTrue(ownWindowEventDecision(own, own, OWN_WINDOW_ID, memo, { true }, resolve).skip)
    memo.clear()
    type = AccessibilityWindowInfo.TYPE_INPUT_METHOD
    assertFalse(ownWindowEventDecision(own, own, OWN_WINDOW_ID, memo, { true }, resolve).skip)
    assertEquals(2, resolutions)
  }

  @Test
  fun `only added removed or unknown windows changes invalidate`() {
    val windows = AccessibilityEvent.TYPE_WINDOWS_CHANGED
    assertTrue(invalidatesOwnWindowTypes(windows, null))
    assertTrue(invalidatesOwnWindowTypes(windows, AccessibilityEvent.WINDOWS_CHANGE_ADDED))
    assertTrue(invalidatesOwnWindowTypes(windows, AccessibilityEvent.WINDOWS_CHANGE_REMOVED))
    assertTrue(
      invalidatesOwnWindowTypes(
        windows,
        AccessibilityEvent.WINDOWS_CHANGE_ADDED or AccessibilityEvent.WINDOWS_CHANGE_BOUNDS,
      )
    )
    val harmless =
      AccessibilityEvent.WINDOWS_CHANGE_BOUNDS or
        AccessibilityEvent.WINDOWS_CHANGE_FOCUSED or
        AccessibilityEvent.WINDOWS_CHANGE_ACTIVE or
        AccessibilityEvent.WINDOWS_CHANGE_TITLE
    assertFalse(invalidatesOwnWindowTypes(windows, harmless))
    assertFalse(invalidatesOwnWindowTypes(windows, 0))
    for (type in
      listOf(
        AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
        AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
      )) {
      assertFalse(invalidatesOwnWindowTypes(type, null))
      assertFalse(invalidatesOwnWindowTypes(type, AccessibilityEvent.WINDOWS_CHANGE_ADDED))
    }
  }

  @Test
  fun `negative id fails open without resolving or reading prototype state`() {
    val memo = OwnWindowTypeMemo(nowMs = { error("No clock read for an invalid id") })
    repeat(BURST_COUNT) {
      assertEquals(
        OwnWindowEventDecision(false, null),
        ownWindowEventDecision(own, own, -1, memo, { error("No state read") }) {
          error("No resolution")
        },
      )
    }
  }

  @Test
  fun `resolved ttl and backwards clock expire entries`() {
    var now = CLOCK_START_MS
    var resolutions = 0
    var type = AccessibilityWindowInfo.TYPE_APPLICATION
    val memo = OwnWindowTypeMemo(nowMs = { now })
    val resolve = {
      resolutions++
      type
    }
    assertEquals(type, memo.windowType(OWN_WINDOW_ID, resolve))
    now = CLOCK_START_MS + RESOLVED_TTL_MS - 1
    assertEquals(type, memo.windowType(OWN_WINDOW_ID, resolve))
    assertEquals(1, resolutions)
    now++
    type = AccessibilityWindowInfo.TYPE_INPUT_METHOD
    assertEquals(type, memo.windowType(OWN_WINDOW_ID, resolve))
    assertEquals(2, resolutions)
    now--
    type = AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY
    assertEquals(type, memo.windowType(OWN_WINDOW_ID, resolve))
    assertEquals(EXPECTED_TTL_RESOLUTIONS, resolutions)
  }

  @Test
  fun `backwards clock also expires unresolved entries`() {
    var now = CLOCK_START_MS
    var resolutions = 0
    val memo = OwnWindowTypeMemo(nowMs = { now })
    assertNull(
      memo.windowType(OWN_WINDOW_ID) {
        resolutions++
        null
      }
    )
    now--
    assertEquals(
      AccessibilityWindowInfo.TYPE_APPLICATION,
      memo.windowType(OWN_WINDOW_ID) {
        resolutions++
        AccessibilityWindowInfo.TYPE_APPLICATION
      },
    )
    assertEquals(2, resolutions)
  }

  @Test
  fun `capacity clears all old ids before storing the new one`() {
    val memo = OwnWindowTypeMemo(nowMs = { 0L }, maxEntries = CAPACITY)
    var resolutions = 0
    repeat(DISTINCT_WINDOW_COUNT) { id ->
      assertEquals(
        AccessibilityWindowInfo.TYPE_APPLICATION,
        memo.windowType(id) {
          resolutions++
          AccessibilityWindowInfo.TYPE_APPLICATION
        },
      )
      assertEquals(
        AccessibilityWindowInfo.TYPE_APPLICATION,
        memo.windowType(id) { error("Fresh entry must be cached") },
      )
    }
    assertEquals(DISTINCT_WINDOW_COUNT, resolutions)
    // The final two ids fill the cap. Adding 0 clears them; the penultimate id then fills it again.
    for (id in listOf(0, DISTINCT_WINDOW_COUNT - 2, DISTINCT_WINDOW_COUNT - 1, 0)) {
      assertEquals(
        AccessibilityWindowInfo.TYPE_INPUT_METHOD,
        memo.windowType(id) {
          resolutions++
          AccessibilityWindowInfo.TYPE_INPUT_METHOD
        },
      )
    }
    // Adding the last id cleared both 0 and the penultimate id; 0 therefore resolves again.
    assertEquals(DISTINCT_WINDOW_COUNT + CAPACITY_RECHECKS, resolutions)
  }

  private companion object {
    const val OWN_WINDOW_ID = 1
    const val FOREIGN_WINDOW_ID = 2
    const val BURST_COUNT = 100
    const val RETRY_MS = 250L
    const val RESOLVED_TTL_MS = 5_000L
    const val CLOCK_START_MS = 100L
    const val SYSTEM_EVENT_COUNT = 3
    const val EXPECTED_RETRY_RESOLUTIONS = 3
    const val EXPECTED_TTL_RESOLUTIONS = 3
    const val CAPACITY = 2
    const val DISTINCT_WINDOW_COUNT = 20
    const val CAPACITY_RECHECKS = 4
  }
}
