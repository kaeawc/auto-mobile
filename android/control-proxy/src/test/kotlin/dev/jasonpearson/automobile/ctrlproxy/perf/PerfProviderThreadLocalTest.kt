package dev.jasonpearson.automobile.ctrlproxy.perf

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PerfProviderThreadLocalTest {

  private fun topLevelNames(json: kotlinx.serialization.json.JsonElement?): List<String> {
    val array = json as? JsonArray ?: return emptyList()
    return array.mapNotNull { it.jsonObject["name"]?.jsonPrimitive?.content }
  }

  @Test
  fun `single-thread nesting still works`() {
    val provider = PerfProvider.createForTesting(SystemTimeProvider())
    provider.serial("root")
    provider.startOperation("child")
    provider.endOperation("child")
    provider.end()

    val names = topLevelNames(provider.flush())
    assertTrue("root should be a top-level entry", names.contains("root"))
  }

  /**
   * An operation left open on another thread must NOT become the parent of an operation started on
   * this thread. Pre-fix the entry stack was shared, so "B" nested under the still-open "A"
   * (issue #3709). Now the stack is per-thread, so "B" is its own top-level root.
   */
  @Test
  fun `entries from different threads do not nest`() {
    val provider = PerfProvider.createForTesting(SystemTimeProvider())
    val aOpened = CountDownLatch(1)
    val releaseA = CountDownLatch(1)

    val threadA = Thread {
      provider.serial("A") // leave "A" open on thread A
      aOpened.countDown()
      releaseA.await()
      provider.end()
    }
    threadA.start()
    assertTrue(aOpened.await(5, TimeUnit.SECONDS))

    // Start and finish "B" on this thread while "A" is still open elsewhere.
    provider.serial("B")
    provider.end()

    val names = topLevelNames(provider.flush())
    assertNotNull(names)
    assertTrue("B should be a top-level completed root", names.contains("B"))
    // Under the old shared stack, B would have been nested inside the still-open A
    // and A (not B) would surface here once flush closed it.
    assertFalse("A must not be flushed by this thread (it's open on thread A)", names.contains("A"))

    releaseA.countDown()
    threadA.join(2_000)
  }
}
