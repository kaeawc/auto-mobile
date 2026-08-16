package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.domain.DeviceGesturePoint
import dev.jasonpearson.automobile.desktop.domain.DeviceGestureStreamCoalescer
import dev.jasonpearson.automobile.desktop.domain.GestureStreamStep
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

/**
 * The pure client-side move-throttle for streamed gestures. Pins BOTH gates (cadence and movement)
 * from both sides — a throttle that only ever emits, or only ever coalesces, would pass a one-sided
 * test while being useless — and the always-emit-first rule that starts tracking without delay.
 */
class DeviceGestureStreamCoalescerTest {

  private fun coalescer() = DeviceGestureStreamCoalescer(minIntervalMs = 16, minMoveDistancePx = 2)

  @Test
  fun `the first sample always emits so tracking starts immediately`() {
    val step = coalescer().offer(x = 100, y = 200, nowMs = 0)

    val emit = assertIs<GestureStreamStep.Emit>(step)
    assertEquals(DeviceGesturePoint(100, 200), emit.point)
  }

  @Test
  fun `a second sample within the cadence interval coalesces even when it moved far`() {
    val c = coalescer()
    c.offer(x = 100, y = 200, nowMs = 0)

    // 8ms < 16ms interval: coalesce regardless of the large jump.
    assertIs<GestureStreamStep.Coalesce>(c.offer(x = 100, y = 900, nowMs = 8))
  }

  @Test
  fun `a sample past the cadence interval that moved enough emits`() {
    val c = coalescer()
    c.offer(x = 100, y = 200, nowMs = 0)

    val emit = assertIs<GestureStreamStep.Emit>(c.offer(x = 100, y = 260, nowMs = 16))
    assertEquals(DeviceGesturePoint(100, 260), emit.point)
  }

  @Test
  fun `a stationary sample past the interval coalesces (no wire frame for a hold)`() {
    val c = coalescer()
    c.offer(x = 100, y = 200, nowMs = 0)

    // Interval satisfied but only 1px of movement (< 2px gate): the runner holds position itself.
    assertIs<GestureStreamStep.Coalesce>(c.offer(x = 100, y = 201, nowMs = 100))
  }

  @Test
  fun `distance is measured from the last EMITTED point, not the last offered one`() {
    val c = coalescer()
    c.offer(x = 100, y = 200, nowMs = 0) // emitted, reference = (100,200)
    c.offer(x = 100, y = 205, nowMs = 4) // coalesced (too soon), does NOT move the reference

    // 20ms later, 5px from the last EMITTED (100,200) — emits. Had the coalesced (100,205)
    // become the reference, this 0px delta would have been dropped.
    val emit = assertIs<GestureStreamStep.Emit>(c.offer(x = 100, y = 205, nowMs = 20))
    assertEquals(DeviceGesturePoint(100, 205), emit.point)
  }

  @Test
  fun `an emitted sample rearms both gates from its own time and point`() {
    val c = coalescer()
    c.offer(x = 100, y = 200, nowMs = 0)
    c.offer(x = 100, y = 260, nowMs = 16) // emit, reference now (100,260)@16

    // 8ms after the SECOND emit (24-16): still inside the interval, so coalesce.
    assertIs<GestureStreamStep.Coalesce>(c.offer(x = 100, y = 400, nowMs = 24))
  }

  @Test
  fun `reset lets the next gesture emit its first sample again`() {
    val c = coalescer()
    c.offer(x = 100, y = 200, nowMs = 0)
    // Mid-interval sample would coalesce...
    assertIs<GestureStreamStep.Coalesce>(c.offer(x = 100, y = 201, nowMs = 4))

    c.reset()
    // ...but after reset the first sample of the new gesture emits unconditionally, same clock.
    assertIs<GestureStreamStep.Emit>(c.offer(x = 500, y = 500, nowMs = 4))
  }
}
