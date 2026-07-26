package dev.jasonpearson.automobile.desktop.core.control

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

/** Coverage for the overlapping-tap error ordering (issue #3347). */
class ControlTapErrorGateTest {

  @Test
  fun `a fresh token is current until a newer one is claimed`() {
    val gate = ControlTapErrorGate()

    val a = gate.nextToken()
    assertTrue(gate.isCurrent(a))

    val b = gate.nextToken()
    assertFalse(gate.isCurrent(a), "an older attempt is no longer current once a newer one starts")
    assertTrue(gate.isCurrent(b))
  }

  @Test
  fun `a stale failure from a superseded tap is suppressed while the latest publishes`() {
    val gate = ControlTapErrorGate()
    var published: String? = "previous-banner"

    // Two overlapping clicks: A then B (B supersedes A before either completes).
    val tokenA = gate.nextToken()
    val tokenB = gate.nextToken()
    // Latest tap clears the banner at click time.
    published = null

    fun completeWithError(token: Long, message: String) {
      if (gate.isCurrent(token)) published = message
    }

    // A fails late — it is no longer the latest, so its stale error must not resurrect the banner.
    completeWithError(tokenA, "A: no active device")
    assertEquals(null, published)

    // B then fails — it is the latest, so its error is the one the user sees.
    completeWithError(tokenB, "B: tap out of range")
    assertEquals("B: tap out of range", published)
  }

  @Test
  fun `a late success does not let a stale failure overwrite it`() {
    val gate = ControlTapErrorGate()
    var published: String? = null

    val tokenA = gate.nextToken()
    val tokenB = gate.nextToken()

    fun completeWithError(token: Long, message: String) {
      if (gate.isCurrent(token)) published = message
    }

    // B succeeds (success path never touches the banner), then A's late failure is suppressed.
    completeWithError(tokenA, "A: stale failure")
    assertEquals(null, published, "B succeeded and is latest; A's stale failure must be ignored")
  }
}
