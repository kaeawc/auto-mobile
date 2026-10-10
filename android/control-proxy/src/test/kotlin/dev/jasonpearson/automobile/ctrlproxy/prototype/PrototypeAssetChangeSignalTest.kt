package dev.jasonpearson.automobile.ctrlproxy.overlay

import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The change signal the renderer's image cache depends on: one report per change (put, remove,
 * clear, session drop), none for a rejected put, always delivered with the store's locks released
 * so a listener that reads the store cannot deadlock. Cross-thread checks join with a timeout, so a
 * regression fails the join rather than hanging the suite.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class OverlayAssetChangeSignalTest {
  private val files = FakeOverlayAssetFiles()
  private val worker = QueuedExecutor()
  private var session = 1
  private val limits = OverlayAssetLimits(maxAssetBytes = 100, maxCount = 2, maxTotalBytes = 150)
  private val store = OverlayAssetStore(files, limits, session = { session }, fileWorker = worker)
  private val signals = mutableListOf<Set<String>?>()

  private fun put(id: String, size: Int = 20) =
    store.put(id, "image/png", OverlayAssetBytes.png(size))

  private fun listen(block: (Set<String>?) -> Unit = {}) = store.setChangeListener { ids ->
    signals += ids?.toSet()
    block(ids)
  }

  private fun <T> otherThread(block: () -> T): T {
    var result: Result<T>? = null
    val caller = thread { result = runCatching(block) }
    caller.join(JOIN_MS)
    assertFalse("blocked on a store lock held by the listener's caller", caller.isAlive)
    return checkNotNull(result).getOrThrow()
  }

  @Test
  fun `a put reports its id once, for a new id and for a replacement`() {
    listen()
    put("hero")
    put("hero", 30)
    assertEquals(listOf<Set<String>?>(setOf("hero"), setOf("hero")), signals)
  }

  @Test
  fun `a rejected put reports nothing`() {
    listen()
    store.put("bad", "image/png", ByteArray(8))
    put("a")
    put("b")
    signals.clear()
    assertTrue(put("c") is OverlayAssetPutResult.Rejected)
    assertTrue(signals.isEmpty())
  }

  @Test
  fun `remove reports only when something was removed`() {
    put("a")
    listen()
    assertFalse(store.remove("nope"))
    assertTrue(signals.isEmpty())
    assertTrue(store.remove("a"))
    assertEquals(listOf<Set<String>?>(setOf("a")), signals)
  }

  @Test
  fun `clear reports every asset`() {
    put("a")
    listen()
    store.clear()
    assertEquals(listOf<Set<String>?>(null), signals)
  }

  @Test
  fun `a session change reports every asset on the first touch, whichever call it is`() {
    val touches =
      listOf<Pair<String, (OverlayAssetStore) -> Any?>>(
        "lookup" to { it.lookup("a") },
        "read" to { it.read("a") },
        "count" to { it.count },
        "totalByteCount" to { it.totalByteCount },
        "ids" to { it.ids() },
        "remove" to { it.remove("a") },
        "put" to { it.put("b", "image/png", OverlayAssetBytes.png()) },
      )
    touches.forEach { (name, touch) ->
      val fresh = OverlayAssetStore(files, limits, session = { session }, fileWorker = worker)
      fresh.put("a", "image/png", OverlayAssetBytes.png())
      val seen = mutableListOf<Set<String>?>()
      fresh.setChangeListener { seen += it?.toSet() }
      session++
      touch(fresh)
      assertTrue(name, seen.contains(null))
      assertNull(name, fresh.lookup("a"))
    }
  }

  @Test
  fun `a put whose write outlives a session change reports the drop but not itself`() {
    put("old")
    listen()
    files.onWrite = { session = 2 }
    val result = put("late") as OverlayAssetPutResult.Rejected
    assertEquals(OverlayAssetRejection.SESSION_ENDED, result.reason)
    assertEquals(listOf<Set<String>?>(null), signals)
    assertNull(store.lookup("old"))
    assertNull(store.lookup("late"))
  }

  @Test
  fun `the listener runs with neither the store monitor nor the put lock held`() {
    var nested = false
    listen {
      assertFalse("store monitor held", Thread.holdsLock(store))
      if (!nested) {
        nested = true
        // Another thread can take the monitor (lookup) and the put lock (put) right now.
        otherThread { store.lookup("a") }
        otherThread { put("other") }
      }
    }
    put("a")
    assertEquals("a", store.lookup("a")?.id)
    assertEquals("other", store.lookup("other")?.id)
    store.remove("a")
    store.clear()
  }

  @Test
  fun `a listener that reads the store while being notified sees the change that woke it`() {
    val seen = mutableListOf<String>()
    listen { ids ->
      ids?.forEach { id ->
        seen += "$id:${store.lookup(id)?.byteCount}:${store.read(id)?.size}"
        assertEquals(store.count, store.ids().size)
      }
    }
    put("hero", 30)
    assertEquals(listOf("hero:30:30"), seen)
    seen.clear()
    store.remove("hero")
    assertEquals(listOf("hero:null:null"), seen)
    put("a")
    store.clear()
    assertEquals(0, store.count)
  }

  @Test
  fun `a listener that reads the store from another thread is not blocked by the notifying call`() {
    val onOther = mutableListOf<OverlayAssetInfo?>()
    listen { ids -> ids?.forEach { id -> onOther += otherThread { store.lookup(id) } } }
    put("hero")
    store.remove("hero")
    assertEquals(listOf(OverlayAssetInfo("hero", "image/png", 20), null), onOther)
  }

  @Test
  fun `passing null stops delivery`() {
    listen()
    store.setChangeListener(null)
    put("a")
    assertTrue(signals.isEmpty())
  }

  private companion object {
    const val JOIN_MS = 5_000L
  }
}
