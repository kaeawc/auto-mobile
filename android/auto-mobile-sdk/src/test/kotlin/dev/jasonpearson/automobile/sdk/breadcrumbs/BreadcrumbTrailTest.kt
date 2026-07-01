package dev.jasonpearson.automobile.sdk.breadcrumbs

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class BreadcrumbTrailTest {

  private lateinit var trail: BreadcrumbTrail

  @Before
  fun setup() {
    trail = BreadcrumbTrail(maxSize = 5)
  }

  @Test
  fun `snapshot returns breadcrumbs in insertion order`() {
    val b1 = Breadcrumb(1L, BreadcrumbCategory.NAVIGATION, "screen A")
    val b2 = Breadcrumb(2L, BreadcrumbCategory.TAP, "button X")
    val b3 = Breadcrumb(3L, BreadcrumbCategory.CUSTOM, "event Y", mapOf("key" to "value"))

    trail.add(b1)
    trail.add(b2)
    trail.add(b3)

    assertEquals(listOf(b1, b2, b3), trail.snapshot())
  }

  @Test
  fun `ring buffer evicts oldest when full`() {
    val maxSize = 5
    // Add maxSize + 10 items
    for (i in 1..maxSize + 10) {
      trail.add(Breadcrumb(i.toLong(), BreadcrumbCategory.LOG, "msg $i"))
    }

    val snapshot = trail.snapshot()
    assertEquals(maxSize, snapshot.size)
    // Only the last 5 remain (items 11..15)
    for ((index, bc) in snapshot.withIndex()) {
      assertEquals("msg ${index + 11}", bc.message)
    }
  }

  @Test
  fun `clear empties the trail`() {
    trail.add(Breadcrumb(1L, BreadcrumbCategory.CUSTOM, "a"))
    trail.add(Breadcrumb(2L, BreadcrumbCategory.CUSTOM, "b"))

    trail.clear()

    assertTrue(trail.snapshot().isEmpty())
  }

  @Test
  fun `snapshot returns a copy`() {
    trail.add(Breadcrumb(1L, BreadcrumbCategory.CUSTOM, "before"))

    val snap = trail.snapshot()

    // Modify trail after snapshot
    trail.add(Breadcrumb(2L, BreadcrumbCategory.CUSTOM, "after"))

    assertEquals(1, snap.size)
    assertEquals("before", snap[0].message)
  }

  @Test
  fun `concurrent adds produce correct count`() {
    val largeTrail = BreadcrumbTrail(maxSize = 1000)
    val threadCount = 10
    val addsPerThread = 100
    val latch = CountDownLatch(threadCount)
    val executor = Executors.newFixedThreadPool(threadCount)

    for (t in 0 until threadCount) {
      executor.submit {
        try {
          for (i in 0 until addsPerThread) {
            largeTrail.add(
                Breadcrumb(
                    System.nanoTime(),
                    BreadcrumbCategory.CUSTOM,
                    "t$t-i$i",
                ),
            )
          }
        } finally {
          latch.countDown()
        }
      }
    }

    latch.await()
    executor.shutdown()

    assertEquals(threadCount * addsPerThread, largeTrail.snapshot().size)
  }

  @Test
  fun `default maxSize is 100`() {
    val defaultTrail = BreadcrumbTrail()
    for (i in 1..150) {
      defaultTrail.add(Breadcrumb(i.toLong(), BreadcrumbCategory.CUSTOM, "msg $i"))
    }
    assertEquals(100, defaultTrail.snapshot().size)
  }
}
