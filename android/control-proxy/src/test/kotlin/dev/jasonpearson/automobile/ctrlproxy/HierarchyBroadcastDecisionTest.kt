package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Guards the event-driven broadcast policy (#5468): an `Unchanged` hierarchy result must never
 * trigger a full `hierarchy_update` re-broadcast, while a `Changed` result still does (subject to
 * the broadcast throttle) exactly as before.
 */
class HierarchyBroadcastDecisionTest {

  private fun hierarchy() = ViewHierarchy()

  @Test
  fun `changed result broadcasts full payload when throttle allows`() {
    val decision =
      decideHierarchyBroadcast(
        HierarchyResult.Changed(hierarchy(), hash = 1, extractionTimeMs = 5),
        shouldBroadcast = { true },
      )

    assertEquals(HierarchyBroadcastDecision.BroadcastFull, decision)
  }

  @Test
  fun `changed result skips when throttled`() {
    val decision =
      decideHierarchyBroadcast(
        HierarchyResult.Changed(hierarchy(), hash = 1, extractionTimeMs = 5),
        shouldBroadcast = { false },
      )

    assertEquals(HierarchyBroadcastDecision.SkipThrottled, decision)
  }

  @Test
  fun `unchanged result never broadcasts even when throttle allows`() {
    val decision =
      decideHierarchyBroadcast(
        HierarchyResult.Unchanged(
          hierarchy(),
          hash = 1,
          extractionTimeMs = 5,
          skippedEventCount = 3,
        ),
        // Throttle wide open — the old code would have re-broadcast the full byte-identical
        // payload here; the fix must skip it regardless.
        shouldBroadcast = { true },
      )

    assertEquals(HierarchyBroadcastDecision.SkipUnchanged, decision)
  }

  @Test
  fun `unchanged result never broadcasts and never consults the throttle`() {
    var throttleConsulted = false
    val decision =
      decideHierarchyBroadcast(
        HierarchyResult.Unchanged(
          hierarchy(),
          hash = 1,
          extractionTimeMs = 5,
          skippedEventCount = 3,
        ),
        shouldBroadcast = {
          throttleConsulted = true
          true
        },
      )

    assertEquals(HierarchyBroadcastDecision.SkipUnchanged, decision)
    assertEquals(
      "Unchanged results must skip unconditionally without touching the throttle",
      false,
      throttleConsulted,
    )
  }
}
