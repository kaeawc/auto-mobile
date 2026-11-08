package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.*
import org.junit.Test

class PrototypeLoopsTest {
  @Test
  fun `capture hold renews for a bounded window using a fake clock`() {
    var now = 100L
    val activity = PrototypeMotionActivity(clock = { now })
    assertFalse(activity.captureHeld())
    assertEquals(PrototypeMotionState.Settled, activity.snapshotForCapture())
    now = 1599L
    assertTrue(activity.captureHeld())
    assertEquals(PrototypeMotionState.Settled, activity.snapshotForCapture())
    now = 1600L
    assertTrue(activity.captureHeld())
    now = 3099L
    assertFalse(activity.captureHeld())
  }

  @Test
  fun `pulse and spin return to exact identity after each iteration`() {
    for (progress in listOf(0f, 1f, 2f, 20f)) {
      assertEquals(1f, prototypeLoopScale("pulse", progress), 0f)
      assertEquals(0f, prototypeLoopRotation("spin", progress), 0f)
    }
    assertEquals(1.08f, prototypeLoopScale("pulse", 0.5f), 0.00001f)
    assertEquals(180f, prototypeLoopRotation("spin", 0.5f), 0f)
  }
}
