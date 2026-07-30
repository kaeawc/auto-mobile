package dev.jasonpearson.automobile.video

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the encode-loop shutdown-race fix for issue #4748: the shutdown hook nulls `streamWriter`
 * (and `audioCapture`) on a separate thread while the encode loop reads them. Before the fix the
 * loop dereferenced `streamWriter!!`, so a concurrent null between the `while (running)` check and
 * the deref threw a spurious [NullPointerException]. The loop now snapshots the volatile field via
 * [VideoServer.encodeLoopSnapshot] and breaks on null (`?: break`), exiting cleanly during
 * teardown.
 *
 * These are deterministic contract tests for that snapshot seam — no threads, no timing — so they
 * exercise the exact null-tolerance the loop relies on without flaking under CI's timing/CPU.
 */
class VideoServerEncodeLoopTest {
  /** Stand-in for the concrete `VideoStreamWriter` so the test stays free of Android framework. */
  private class Writer

  @Test
  fun snapshotReturnsFieldWhenPresentAndNullWhenClearedByShutdown() {
    val writer = Writer()
    // A live field is handed back unchanged for the iteration to use.
    assertSame(writer, VideoServer.encodeLoopSnapshot(writer))
    // Once the shutdown hook has nulled the field, the snapshot is null: the loop breaks cleanly
    // instead of a `!!` deref throwing.
    assertNull(VideoServer.encodeLoopSnapshot<Writer>(null))
  }

  @Test
  fun encodeLoopBreaksWhenSnapshotObservesNullFromShutdown() {
    // Model the loop's guard exactly: `val currentWriter = encodeLoopSnapshot(streamWriter) ?:
    // break`.
    // While the field is live the loop keeps iterating; the instant the shutdown hook nulls it the
    // snapshot returns null and the loop breaks — no `!!` deref, no NullPointerException.
    var streamWriter: Writer? = Writer()
    var iterations = 0
    var brokeOnNull = false

    while (true) {
      val currentWriter = VideoServer.encodeLoopSnapshot(streamWriter)
      if (currentWriter == null) {
        brokeOnNull = true
        break
      }
      iterations++
      // Simulate the shutdown hook nulling the field after a couple of live iterations.
      if (iterations == 2) {
        streamWriter = null
      }
    }

    assertEquals("loop should run twice on the live writer before shutdown nulls it", 2, iterations)
    assertTrue("loop should exit via the null snapshot, not a deref throw", brokeOnNull)
  }
}
