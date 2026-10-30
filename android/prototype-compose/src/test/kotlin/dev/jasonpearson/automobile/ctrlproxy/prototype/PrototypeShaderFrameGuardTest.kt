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
      PrototypeShaderSession().apply {
        setVisible(true)
        register("warm")
      }
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
  fun `trips on the eighth slow interval across repeated effect restarts`() {
    val clock = FakeClock()
    val guard = PrototypeShaderFrameGuard(clock::nanos)
    guard.frame()
    repeat(7) {
      clock.advance(25)
      assertTrue(guard.frame())
      guard.pause()
      clock.advance(500)
      assertTrue(guard.frame())
    }
    clock.advance(25)
    assertFalse(guard.frame())
    assertEquals("frame budget exceeded while shaders were active", guard.disabledReason)
    guard.pause()
    assertFalse(guard.frame())
  }

  @Test
  fun `zero and backwards timestamps do not erase a streak or change its baseline`() {
    val guard = PrototypeShaderFrameGuard()
    guard.frame(0)
    repeat(7) { assertTrue(guard.frame((it + 1) * 25_000_000L)) }
    assertTrue(guard.frame(175_000_000L))
    assertTrue(guard.frame(1))
    assertFalse(guard.frame(200_000_000L))
  }

  @Test
  fun `spaced slow frames trip only with more than half of a full sliding window`() {
    val clock = FakeClock()
    val guard = PrototypeShaderFrameGuard(clock::nanos)
    guard.frame()
    repeat(60) {
      clock.advance(if (it % 2 == 0) 24 else 25)
      assertTrue(guard.frame())
    }
    // The oldest fast interval leaves: 31 of the most recent 60 are now slow.
    clock.advance(25)
    assertFalse(guard.frame())
  }

  @Test
  fun `sliding window ages out slow samples and gaps never count as work`() {
    val clock = FakeClock()
    val guard = PrototypeShaderFrameGuard(clock::nanos)
    guard.frame()
    repeat(200) {
      clock.advance(if (it % 3 == 0) 25 else 24)
      assertTrue(guard.frame())
      guard.pause()
      clock.advance(5000)
      assertTrue(guard.frame())
    }
    assertNull(guard.disabledReason)
  }

  @Test
  fun `duplicate identities have separate guards and disposal evicts registrations`() {
    val session = PrototypeShaderSession()
    val first = session.register("repeat/key")
    val second = session.register("repeat/key")
    assertNotEquals(first.id, second.id)
    assertNotSame(first.guard, second.guard)
    first.guard.disable(longFailure)
    first.guard.disable("replacement")
    assertNull(second.guard.disabledReason)
    assertEquals(1, session.failures().size)
    assertTrue(session.failures().values.single().toByteArray().size <= 2048)
    session.unregister(first)
    session.unregister(second)
    assertEquals(0, session.registeredCount)
    assertEquals(1, session.failures().size)
  }

  @Test
  fun `failure history is capped and counts omitted disposed entries`() {
    val session = PrototypeShaderSession()
    repeat(70) {
      val entry = session.register("repeat/key")
      entry.guard.disable("failure $it")
      session.unregister(entry)
    }
    assertEquals(0, session.registeredCount)
    assertEquals(65, session.failures().size)
    assertEquals("Additional shader failures omitted", session.failures()["+6 more"])
  }

  @Test
  fun `one prototype budget survives node churn and stops while hidden or inactive`() {
    val session = PrototypeShaderSession()
    val clock = FakeClock()
    session.setVisible(true)
    repeat(8) { index ->
      val node = session.register("same")
      session.setActive(node, true)
      assertTrue(session.sampling.value)
      assertTrue(session.frame(clock.now))
      clock.advance(25)
      assertEquals(index < 7, session.frame(clock.now))
      session.setVisible(false)
      clock.advance(5000)
      assertFalse(session.frame(clock.now))
      session.unregister(node)
      session.setVisible(true)
      assertFalse(session.sampling.value)
    }
    val failures = session.failures()
    assertEquals(mapOf("prototype" to "frame budget exceeded while shaders were active"), failures)
    val later = session.register("later")
    session.setActive(later, true)
    assertFalse(session.sampling.value)
    assertEquals(failures, session.failures())
  }

  @Test
  fun `losing one active node does not interrupt the shared signal`() {
    val session = PrototypeShaderSession()
    val first = session.register("same")
    val second = session.register("same")
    session.setVisible(true)
    session.setActive(first, true)
    session.setActive(second, true)
    session.frame(0)
    repeat(7) { assertTrue(session.frame((it + 1) * 25_000_000L)) }
    session.unregister(first)
    assertFalse(session.frame(200_000_000L))
    assertEquals(1, session.failures().size)
  }

  @Test
  fun `window handoff has one sampler and old disposal cannot hide or pause the new root`() {
    val session = PrototypeShaderSession()
    val node = session.register("node")
    session.setActive(node, true)
    val old = Any()
    val replacement = Any()
    session.setVisible(true, old)
    session.frame(0, old)
    repeat(7) { assertTrue(session.frame((it + 1) * 25_000_000L, old)) }
    session.setVisible(true, replacement)
    assertSame(replacement, session.samplingOwner.value)
    session.setVisible(false, old)
    session.removeSampler(old)
    session.pause(old)
    assertTrue(session.sampling.value)
    assertFalse(session.frame(5_000_000_000L, old))
    assertTrue(session.frame(5_000_000_000L, replacement))
    // A late cancellation from the old loop must not discard this interval.
    session.pause(old)
    assertFalse(session.frame(5_025_000_000L, replacement))
    assertEquals(1, session.failures().size)
  }

  @Test
  fun `removing a replacement sampler restores a still composed older window`() {
    val session = PrototypeShaderSession()
    session.setActive(session.register("node"), true)
    val old = Any()
    val replacement = Any()
    session.setVisible(true, old)
    session.setVisible(false, replacement)
    assertFalse(session.sampling.value)
    session.removeSampler(replacement)
    assertTrue(session.sampling.value)
    assertSame(old, session.samplingOwner.value)
    assertTrue(session.frame(0, old))
    session.removeSampler(old)
    assertFalse(session.sampling.value)
    assertNull(session.samplingOwner.value)
  }
}
