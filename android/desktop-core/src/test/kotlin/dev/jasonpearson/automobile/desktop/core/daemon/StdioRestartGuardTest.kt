package dev.jasonpearson.automobile.desktop.core.daemon

import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import org.junit.Test

class StdioRestartGuardTest {
  private var nowNanos = 0L
  private val policy =
    StdioRestartPolicy(
      maxQuickExits = 2,
      healthyUptimeMs = 1_000,
      coolDownMs = 100,
      maxCoolDownMs = 350,
    )
  private val guard = StdioRestartGuard(policy) { nowNanos }

  private fun advance(ms: Long) {
    nowNanos += TimeUnit.MILLISECONDS.toNanos(ms)
  }

  @Test
  fun `starts are allowed until the quick exit limit is reached`() {
    guard.recordExit(startedAtNanos = nowNanos)

    assertEquals(0, guard.remainingCoolDownMs())
    assertEquals(1, guard.consecutiveQuickExits)
  }

  @Test
  fun `reaching the limit blocks for the cool-down and then allows one trial`() {
    guard.recordExit(nowNanos)
    guard.recordExit(nowNanos)

    assertEquals(100, guard.remainingCoolDownMs())
    advance(40)
    assertEquals(60, guard.remainingCoolDownMs())
    advance(60)
    assertEquals(0, guard.remainingCoolDownMs())
  }

  @Test
  fun `each further quick exit doubles the wait up to the cap`() {
    guard.recordExit(nowNanos)
    guard.recordExit(nowNanos)
    assertEquals(100, guard.remainingCoolDownMs())

    advance(100)
    guard.recordExit(nowNanos)
    assertEquals(200, guard.remainingCoolDownMs())

    advance(200)
    guard.recordExit(nowNanos)
    assertEquals(350, guard.remainingCoolDownMs(), "400ms is capped at maxCoolDownMs")
  }

  @Test
  fun `a child that lived long enough clears the count`() {
    guard.recordExit(nowNanos)
    val started = nowNanos
    advance(1_000)

    guard.recordExit(started)

    assertEquals(0, guard.consecutiveQuickExits)
    assertEquals(0, guard.remainingCoolDownMs())
  }

  @Test
  fun `a child that never started counts as a quick exit`() {
    guard.recordExit(startedAtNanos = null)
    guard.recordExit(startedAtNanos = null)

    assertEquals(100, guard.remainingCoolDownMs())
  }
}
