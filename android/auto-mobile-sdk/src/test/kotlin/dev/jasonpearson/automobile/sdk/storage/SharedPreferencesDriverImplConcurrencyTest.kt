package dev.jasonpearson.automobile.sdk.storage

import android.content.Context
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class SharedPreferencesDriverImplConcurrencyTest {

  @Test
  fun `bounds one file queue and exposes the evicted sequence gap`() {
    val context = RuntimeEnvironment.getApplication() as Context
    val driver = SharedPreferencesDriverImpl(context)
    val fileName = "bounded-changes"
    val preferences = context.getSharedPreferences(fileName, Context.MODE_PRIVATE)
    preferences.edit().clear().commit()

    driver.startListening(fileName)
    try {
      repeat(257) { index ->
        preferences.edit().putInt("value", index).commit()
      }

      val changes = driver.getQueuedChanges(fileName, 0)

      assertEquals(256, changes.size)
      assertEquals(2L, changes.first().sequenceNumber)
      assertEquals(257L, changes.last().sequenceNumber)
    } finally {
      driver.stopListening(fileName)
      preferences.edit().clear().commit()
    }
  }

  @Test
  fun `concurrent start stop and getQueuedChanges do not corrupt maps`() {
    val context = RuntimeEnvironment.getApplication() as Context
    val driver = SharedPreferencesDriverImpl(context)

    val threadCount = 8
    val perThread = 150
    val errors = CopyOnWriteArrayList<Throwable>()
    val latch = CountDownLatch(threadCount)

    // Distinct file names per thread so the outer maps (sharedPrefsListeners,
    // changeQueues, valueSnapshots) are structurally modified concurrently. Under
    // plain HashMaps this trips ConcurrentModificationException / a corrupted map
    // (#3601); with ConcurrentHashMap it stays consistent.
    for (t in 0 until threadCount) {
      Thread {
        try {
          for (i in 0 until perThread) {
            val file = "prefs-$t-$i"
            driver.startListening(file)
            driver.isListening(file)
            driver.getQueuedChanges(file, 0)
            driver.stopListening(file)
          }
        } catch (e: Throwable) {
          errors.add(e)
        } finally {
          latch.countDown()
        }
      }
        .start()
    }

    assertTrue("concurrent access timed out", latch.await(30, TimeUnit.SECONDS))
    assertTrue("concurrent access threw: ${errors.firstOrNull()}", errors.isEmpty())
    driver.stopAllListening()
  }
}
