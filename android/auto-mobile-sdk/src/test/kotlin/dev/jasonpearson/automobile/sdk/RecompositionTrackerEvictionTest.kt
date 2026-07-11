package dev.jasonpearson.automobile.sdk

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class RecompositionTrackerEvictionTest {

  @After
  fun tearDown() {
    RecompositionTracker.setEnabled(false) // clears entries
  }

  /**
   * Per-instance ids (e.g. a long feed keyed by item id) must not grow the entries map without
   * bound; the tracker caps it and evicts the least-recently-touched entries (issue #3708).
   */
  @Test
  fun `entries are bounded and evict the least recently touched`() {
    RecompositionTracker.setEnabled(true)

    val total = 600
    for (i in 0 until total) {
      RecompositionTracker.recordRecomposition("view-$i")
    }

    val entries = JSONObject(RecompositionTracker.buildSnapshotJson("test")).getJSONArray("entries")
    val ids = mutableSetOf<String>()
    for (i in 0 until entries.length()) {
      ids.add(entries.getJSONObject(i).getString("id"))
    }

    assertTrue("entries map must stay bounded, was ${entries.length()}", entries.length() <= 512)
    assertTrue("the most recently recorded id must survive", ids.contains("view-${total - 1}"))
    assertFalse("the oldest id must have been evicted", ids.contains("view-0"))
  }
}
