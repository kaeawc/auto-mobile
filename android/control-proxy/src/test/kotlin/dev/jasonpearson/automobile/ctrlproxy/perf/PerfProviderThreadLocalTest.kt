package dev.jasonpearson.automobile.ctrlproxy.perf

import dev.jasonpearson.automobile.ctrlproxy.RequestIdContext
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
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

  @Test
  fun `completed entries are drained only by their request context`() {
    val provider = PerfProvider.createForTesting(SystemTimeProvider())
    val aCompleted = CountDownLatch(1)
    val allowAFlush = CountDownLatch(1)
    val threadFailure = AtomicReference<Throwable?>()

    val threadA = Thread {
      try {
        runBlocking(RequestIdContext("request-A") + PerfRequestContext("request-A")) {
          provider.startOperation("operation-A")
          provider.endOperation("operation-A")
          aCompleted.countDown()
          check(allowAFlush.await(5, TimeUnit.SECONDS))
          val names = topLevelNames(provider.flush())
          check(names == listOf("operation-A")) { "Unexpected request-A timings: $names" }
        }
      } catch (failure: Throwable) {
        threadFailure.set(failure)
      }
    }
    threadA.start()
    assertTrue(aCompleted.await(5, TimeUnit.SECONDS))

    runBlocking(RequestIdContext("request-B") + PerfRequestContext("request-B")) {
      provider.startOperation("operation-B")
      provider.endOperation("operation-B")
      assertEquals(listOf("operation-B"), topLevelNames(provider.flush()))
    }

    allowAFlush.countDown()
    threadA.join(2_000)
    assertFalse("request-A worker should complete", threadA.isAlive)
    threadFailure.get()?.let { throw AssertionError("request-A worker failed", it) }
  }

  @Test
  fun `completed entry cap evicts oldest request lists`() {
    val provider = PerfProvider.createForTesting(SystemTimeProvider())
    repeat(1_001) { index ->
      provider.complete(
        MutablePerfEntry(
          name = "operation-$index",
          startTime = 0L,
          requestId = "request-$index",
          endTime = 1L,
        ),
      )
    }

    assertTrue("oldest request list should be evicted", provider.flush("request-0") == null)
    assertEquals(listOf("operation-1"), topLevelNames(provider.flush("request-1")))
    assertEquals(listOf("operation-1000"), topLevelNames(provider.flush("request-1000")))
  }

  @Test
  fun `request scope end clears its completed entries`() {
    val provider = PerfProvider.createForTesting(SystemTimeProvider())
    runBlocking(RequestIdContext("request-A") + PerfRequestContext("request-A")) {
      provider.withRequestScope("request-A") {
        provider.complete(
          MutablePerfEntry(
            name = "operation-A",
            startTime = 0L,
            requestId = "request-A",
            endTime = 1L,
          ),
        )
      }
    }

    assertTrue("discarded request should have no timings", provider.flush("request-A") == null)
  }

  @Test
  fun `entry completing after flush snapshot remains for next flush`() {
    val provider = PerfProvider.createForTesting(SystemTimeProvider())
    val snapshotTaken = CountDownLatch(1)
    val entryCompleted = CountDownLatch(1)
    val firstFlush = AtomicReference<kotlinx.serialization.json.JsonElement?>()
    val threadFailure = AtomicReference<Throwable?>()

    val flushThread = Thread {
      try {
        firstFlush.set(
          provider.flush("request-A") {
            snapshotTaken.countDown()
            check(entryCompleted.await(5, TimeUnit.SECONDS))
          },
        )
      } catch (failure: Throwable) {
        threadFailure.set(failure)
      }
    }
    flushThread.start()
    assertTrue("flush should take its snapshot", snapshotTaken.await(5, TimeUnit.SECONDS))

    provider.complete(
      MutablePerfEntry(
        name = "operation-after-snapshot",
        startTime = 0L,
        requestId = "request-A",
        endTime = 1L,
      ),
    )
    entryCompleted.countDown()

    flushThread.join(2_000)
    assertFalse("flush worker should complete", flushThread.isAlive)
    threadFailure.get()?.let { throw AssertionError("flush worker failed", it) }
    assertEquals(emptyList<String>(), topLevelNames(firstFlush.get()))
    assertEquals(
      listOf("operation-after-snapshot"),
      topLevelNames(provider.flush("request-A")),
    )
  }
}
