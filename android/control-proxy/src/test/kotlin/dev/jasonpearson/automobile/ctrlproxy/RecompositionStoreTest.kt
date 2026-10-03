package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.RecompositionEntry
import dev.jasonpearson.automobile.ctrlproxy.models.RecompositionSnapshot
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RecompositionStoreTest {
  @Test
  fun `new store is disabled and ignores updates`() {
    val store = RecompositionStore()
    store.updateSnapshot(RecompositionSnapshot(1L, "app.a", listOf(RecompositionEntry("a"))))

    assertFalse(store.isEnabled())
    assertNull(store.findMatch(extras("a")))
    assertFalse(store.isForPackage("app.a"))
    assertFalse(store.isForPackage(null))
  }

  @Test
  fun `enabled store matches only the recomposition id and package`() {
    val store = RecompositionStore()
    val entry = RecompositionEntry("a", total = 3)
    store.setEnabled(true)
    store.updateSnapshot(RecompositionSnapshot(1L, "app.a", listOf(entry)))

    assertTrue(store.isEnabled())
    assertSame(entry, store.findMatch(extras("a") + ("other" to "ignored")))
    assertNull(store.findMatch(null))
    assertNull(store.findMatch(emptyMap()))
    assertNull(store.findMatch(mapOf("other" to "a")))
    assertNull(store.findMatch(extras("unknown")))
    assertFalse(store.isForPackage(null))
    assertTrue(store.isForPackage("app.a"))
    assertFalse(store.isForPackage("app.b"))
  }

  @Test
  fun `last duplicate id wins`() {
    val store = RecompositionStore()
    val first = RecompositionEntry("a", total = 1)
    val last = RecompositionEntry("a", total = 2)
    store.setEnabled(true)
    store.updateSnapshot(RecompositionSnapshot(1L, "app.a", listOf(first, last)))

    assertSame(last, store.findMatch(extras("a")))
  }

  @Test
  fun `second snapshot replaces all entries and package`() {
    val store = RecompositionStore()
    val next = RecompositionEntry("b")
    store.setEnabled(true)
    store.updateSnapshot(RecompositionSnapshot(1L, "app.a", listOf(RecompositionEntry("a"))))
    store.updateSnapshot(RecompositionSnapshot(2L, "app.b", listOf(next)))

    assertNull(store.findMatch(extras("a")))
    assertSame(next, store.findMatch(extras("b")))
    assertFalse(store.isForPackage("app.a"))
    assertTrue(store.isForPackage("app.b"))
  }

  @Test
  fun `empty snapshot clears entries but sets package`() {
    val store = RecompositionStore()
    store.setEnabled(true)
    store.updateSnapshot(RecompositionSnapshot(1L, "app.a", listOf(RecompositionEntry("a"))))
    store.updateSnapshot(RecompositionSnapshot(2L, "app.b", emptyList()))

    assertNull(store.findMatch(extras("a")))
    assertFalse(store.isForPackage("app.a"))
    assertTrue(store.isForPackage("app.b"))
  }

  @Test
  fun `disabling clears state and re-enabling requires a new snapshot`() {
    val store = RecompositionStore()
    store.setEnabled(true)
    store.updateSnapshot(RecompositionSnapshot(1L, "app.a", listOf(RecompositionEntry("a"))))
    store.setEnabled(false)

    assertFalse(store.isEnabled())
    assertNull(store.findMatch(extras("a")))
    assertFalse(store.isForPackage("app.a"))
    store.updateSnapshot(RecompositionSnapshot(2L, "ignored", listOf(RecompositionEntry("b"))))
    store.setEnabled(true)
    assertTrue(store.isEnabled())
    assertNull(store.findMatch(extras("a")))
    assertNull(store.findMatch(extras("b")))
    assertFalse(store.isForPackage("app.a"))
    assertFalse(store.isForPackage("ignored"))

    val next = RecompositionEntry("c")
    store.updateSnapshot(RecompositionSnapshot(3L, "app.c", listOf(next)))
    assertSame(next, store.findMatch(extras("c")))
    assertTrue(store.isForPackage("app.c"))
  }

  @Test
  fun `mutating caller entries after update does not change store`() {
    val store = RecompositionStore()
    val entry = RecompositionEntry("a")
    val entries = mutableListOf(entry)
    store.setEnabled(true)
    store.updateSnapshot(RecompositionSnapshot(1L, "app.a", entries))
    entries.clear()
    entries.add(RecompositionEntry("b"))
    entries.add(RecompositionEntry("a", total = 99))

    assertSame(entry, store.findMatch(extras("a")))
    assertNull(store.findMatch(extras("b")))
  }

  @Test
  fun `concurrent swaps always retain sentinel and return exact entries`() {
    val store = RecompositionStore()
    val sentinel = RecompositionEntry("sentinel")
    val entriesA = List(64) { RecompositionEntry("a$it", total = it) }
    val entriesB = List(64) { RecompositionEntry("b$it", total = it + 64) }
    val snapshotA = RecompositionSnapshot(1L, "app.a", entriesA + sentinel)
    val snapshotB = RecompositionSnapshot(2L, "app.b", entriesB + sentinel)
    val lookups = (entriesA + entriesB).map { extras(it.id) to it }
    val sentinelExtras = extras(sentinel.id)
    val start = CountDownLatch(1)
    val failure = AtomicReference<Throwable?>(null)
    store.setEnabled(true)
    store.updateSnapshot(snapshotA)

    val writer =
      worker(start, failure) {
        repeat(2000) { store.updateSnapshot(if (it % 2 == 0) snapshotB else snapshotA) }
      }
    val readers =
      List(2) {
        worker(start, failure) {
          repeat(64) {
            for ((idExtras, expected) in lookups) {
              assertSame(
                "Sentinel disappeared during snapshot swap",
                sentinel,
                store.findMatch(sentinelExtras),
              )
              val actual = store.findMatch(idExtras)
              if (actual != null) {
                assertSame(expected, actual)
              }
            }
            store.isForPackage("app.a")
            store.isForPackage("app.b")
            assertFalse(store.isForPackage(null))
          }
        }
      }
    val workers = readers + writer
    workers.forEach { it.start() }
    start.countDown()
    workers.forEach { it.join(10_000) }
    assertTrue(
      "Snapshot workers did not finish within 10 seconds each",
      workers.none { it.isAlive },
    )
    failure.get()?.let { throw it }
    assertSame(sentinel, store.findMatch(sentinelExtras))
  }

  private fun extras(id: String): Map<String, String> =
    mapOf(RecompositionStore.RECOMPOSITION_ID_KEY to id)

  private fun worker(
    start: CountDownLatch,
    failure: AtomicReference<Throwable?>,
    action: () -> Unit,
  ): Thread = Thread {
    try {
      start.await()
      action()
    } catch (error: Throwable) {
      failure.compareAndSet(null, error)
    }
  }
    .apply { isDaemon = true }
}
