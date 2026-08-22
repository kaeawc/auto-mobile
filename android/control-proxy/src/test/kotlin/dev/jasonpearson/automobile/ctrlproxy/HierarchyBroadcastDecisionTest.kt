package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * Guards the content-addressed hierarchy-broadcast dedup policy (#5468).
 *
 * The invariant: an async `hierarchy_update` push is suppressed ONLY when its wire payload is
 * byte-identical to the last one broadcast; every differing payload — including the
 * structurally-"Unchanged"-but-observably-different frames [StructuralHasher] excludes (bounds,
 * rotation, insets), and throttle-deferred changes — still flows. `sync` pushes and the first frame
 * after a new client connects always send.
 */
class HierarchyBroadcastDecisionTest {

  private fun hierarchy(
    updatedAt: Long = 1_000L,
    rotation: Int? = 0,
    packageName: String? = "com.example.app",
    root: UIElementInfo? = UIElementInfo(className = "android.widget.FrameLayout"),
  ) =
    ViewHierarchy(
      updatedAt = updatedAt,
      packageName = packageName,
      hierarchy = root,
      rotation = rotation,
    )

  // --- dedup key normalization (Codex finding #1: lossy structural hash) ---

  @Test
  fun `dedup key ignores the per-extraction updatedAt timestamp`() {
    // Two extractions of the same screen differ only in updatedAt (defaults to now()). Without
    // normalization a serialized-payload comparison would never match and dedup would be a no-op.
    val a = hierarchyBroadcastDedupKey(hierarchy(updatedAt = 1_000L))
    val b = hierarchyBroadcastDedupKey(hierarchy(updatedAt = 9_999L))

    assertEquals(a, b)
  }

  @Test
  fun `dedup key still distinguishes an observable-only change the structural hash would miss`() {
    // Rotation is outside StructuralHasher entirely, so a rotation-only change is classified
    // Unchanged — but it is observable and MUST NOT be deduped.
    val portrait = hierarchyBroadcastDedupKey(hierarchy(rotation = 0))
    val landscape = hierarchyBroadcastDedupKey(hierarchy(rotation = 1))

    assertNotEquals(portrait, landscape)
  }

  // --- decision policy ---

  @Test
  fun `identical consecutive payload is skipped`() {
    val first = hierarchyBroadcastDedupKey(hierarchy(updatedAt = 1_000L))
    val second = hierarchyBroadcastDedupKey(hierarchy(updatedAt = 2_000L))

    // First send establishes the key.
    assertEquals(
      HierarchyBroadcastDecision.Broadcast,
      decideHierarchyBroadcast(
        first,
        lastBroadcastKey = null,
        sync = false,
        newClientConnected = false,
      ),
    )
    // Second, byte-identical (updatedAt aside) push is suppressed.
    assertEquals(
      HierarchyBroadcastDecision.SkipDuplicate,
      decideHierarchyBroadcast(
        second,
        lastBroadcastKey = first,
        sync = false,
        newClientConnected = false,
      ),
    )
  }

  @Test
  fun `structurally-unchanged but observably-different payload still broadcasts`() {
    // The regression guard for Codex finding #1: same structure, different rotation/insets/bounds.
    val previous = hierarchyBroadcastDedupKey(hierarchy(rotation = 0))
    val rotated = hierarchyBroadcastDedupKey(hierarchy(rotation = 1))

    assertEquals(
      HierarchyBroadcastDecision.Broadcast,
      decideHierarchyBroadcast(
        rotated,
        lastBroadcastKey = previous,
        sync = false,
        newClientConnected = false,
      ),
    )
  }

  @Test
  fun `changed payload broadcasts`() {
    val previous = hierarchyBroadcastDedupKey(hierarchy(packageName = "com.example.app"))
    val changed = hierarchyBroadcastDedupKey(hierarchy(packageName = "com.other.app"))

    assertEquals(
      HierarchyBroadcastDecision.Broadcast,
      decideHierarchyBroadcast(
        changed,
        lastBroadcastKey = previous,
        sync = false,
        newClientConnected = false,
      ),
    )
  }

  @Test
  fun `sync broadcast always sends even when identical`() {
    val key = hierarchyBroadcastDedupKey(hierarchy())

    assertEquals(
      HierarchyBroadcastDecision.Broadcast,
      decideHierarchyBroadcast(
        key,
        lastBroadcastKey = key,
        sync = true,
        newClientConnected = false,
      ),
    )
  }

  @Test
  fun `a newly connected client forces a full send even when identical`() {
    val key = hierarchyBroadcastDedupKey(hierarchy())

    assertEquals(
      HierarchyBroadcastDecision.Broadcast,
      decideHierarchyBroadcast(
        key,
        lastBroadcastKey = key,
        sync = false,
        newClientConnected = true,
      ),
    )
  }
}
