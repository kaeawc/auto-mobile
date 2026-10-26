package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeShaderFrameGuardTest {
  companion object {
    private lateinit var longFailure: String

    @JvmStatic
    @BeforeClass
    fun fixtures() {
      longFailure = "compile failed " + "😀".repeat(1000)
      check(longFailure.toByteArray().size > 2048)
    }
  }

  private class FakeClock {
    var now = 0L

    fun nanos(): Long = now

    fun advance(ms: Long) {
      now += ms * 1_000_000
    }
  }

  @Test
  fun `trips on the eighth consecutive over-budget interval and never recovers`() {
    val clock = FakeClock()
    val guard = PrototypeShaderFrameGuard(clock::nanos)
    assertTrue(guard.frame())
    repeat(7) {
      clock.advance(25)
      assertTrue(guard.frame())
    }
    clock.advance(25)
    assertFalse(guard.frame())
    assertTrue(guard.disabledReason.orEmpty().contains("8 consecutive"))
    guard.pause()
    clock.advance(1)
    assertFalse(guard.frame())
  }

  @Test
  fun `at budget and isolated slow frames reset the streak`() {
    val clock = FakeClock()
    val guard = PrototypeShaderFrameGuard(clock::nanos)
    guard.frame()
    repeat(30) {
      repeat(7) {
        clock.advance(25)
        assertTrue(guard.frame())
      }
      clock.advance(24)
      assertTrue(guard.frame())
    }
    assertNull(guard.disabledReason)
  }

  @Test
  fun `pause skips hidden time and resets consecutive samples`() {
    val clock = FakeClock()
    val guard = PrototypeShaderFrameGuard(clock::nanos)
    guard.frame()
    repeat(7) {
      clock.advance(25)
      guard.frame()
    }
    guard.pause()
    clock.advance(5000)
    assertTrue(guard.frame())
    clock.advance(25)
    assertTrue(guard.frame())
    assertNull(guard.disabledReason)
  }

  @Test
  fun `session keeps disabled identity and first bounded compile or draw reason`() {
    val session = PrototypeShaderSession()
    val guard = session.guard("root/node")
    guard.disable(longFailure)
    val first = guard.disabledReason
    guard.disable("draw failed")
    assertSame(guard, session.guard("root/node"))
    assertEquals(mapOf("root/node" to first), session.failures())
    assertTrue(first!!.toByteArray().size <= 2048)
    assertNull(session.guard("other").disabledReason)
  }
}
