package dev.jasonpearson.automobile.sdk

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class RecompositionTrackerConcurrencyTest {

  @After
  fun tearDown() {
    RecompositionTracker.setEnabled(false) // clears entries
  }

  private fun durationOf(snapshotJson: String, id: String): Double? {
    val entries = JSONObject(snapshotJson).getJSONArray("entries")
    for (i in 0 until entries.length()) {
      val e = entries.getJSONObject(i)
      if (e.getString("id") == id && e.has("durationMs")) return e.getDouble("durationMs")
    }
    return null
  }

  /**
   * Every recorded duration is exactly 2.0, so the average reported by a snapshot must always be
   * 2.0. Without synchronizing toJson (#3613), a snapshot taken between `durationTotalMs += 2.0`
   * and `durationSamples += 1` in recordDuration reads a torn pair and reports an average > 2.0.
   */
  @Test
  fun `concurrent snapshot never observes a torn duration average`() {
    RecompositionTracker.setEnabled(true)
    val id = "screen-home"
    val threadCount = 6
    val perThread = 1_000
    val errors = CopyOnWriteArrayList<Throwable>()
    val tornAverages = CopyOnWriteArrayList<Double>()
    val latch = CountDownLatch(threadCount)

    val readerRunning = AtomicBoolean(true)
    val reader = Thread {
      while (readerRunning.get()) {
        try {
          val avg = durationOf(RecompositionTracker.buildSnapshotJson("test"), id)
          if (avg != null && kotlin.math.abs(avg - 2.0) > 1e-9) tornAverages.add(avg)
        } catch (e: Throwable) {
          errors.add(e)
        }
      }
    }
    reader.start()

    for (t in 0 until threadCount) {
      Thread {
        try {
          repeat(perThread) {
            RecompositionTracker.recordRecomposition(id)
            RecompositionTracker.recordDuration(id, 2.0)
          }
        } catch (e: Throwable) {
          errors.add(e)
        } finally {
          latch.countDown()
        }
      }
        .start()
    }

    assertTrue("producers timed out", latch.await(30, TimeUnit.SECONDS))
    readerRunning.set(false)
    reader.join(5_000)

    assertTrue("concurrent access threw: ${errors.firstOrNull()}", errors.isEmpty())
    assertTrue("snapshot observed torn duration averages: $tornAverages", tornAverages.isEmpty())
    // Final quiescent snapshot: total == every record, average is exactly 2.0.
    val finalJson = JSONObject(RecompositionTracker.buildSnapshotJson("test"))
    val entries = finalJson.getJSONArray("entries")
    var total = -1
    for (i in 0 until entries.length()) {
      val e = entries.getJSONObject(i)
      if (e.getString("id") == id) total = e.getInt("total")
    }
    assertEquals(threadCount * perThread, total)
    assertEquals(2.0, durationOf(finalJson.toString(), id)!!, 1e-9)
  }
}
