package dev.jasonpearson.automobile.ctrlproxy.prototype

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
 * What the store does while a put is mid-write, when the file work happens, and who owns an asset.
 * The store monitor must stay free during a write, so these calls come from other threads and are
 * joined: a regression fails the join rather than hanging the suite.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeAssetSessionTest {
  private val files = FakePrototypeAssetFiles()
  private val worker = QueuedExecutor()
  private var session = 1
  private val limits = PrototypeAssetLimits(maxAssetBytes = 100, maxCount = 2, maxTotalBytes = 150)
  private val store = PrototypeAssetStore(files, limits, session = { session }, fileWorker = worker)

  private fun put(id: String, size: Int = 20) =
    store.put(id, "image/png", PrototypeAssetBytes.png(size))

  /** Runs [block] on another thread and fails if it cannot finish while this thread is busy. */
  private fun <T> otherThread(block: () -> T): T {
    var result: Result<T>? = null
    val caller = thread { result = runCatching(block) }
    caller.join(JOIN_MS)
    assertFalse("blocked on the store monitor", caller.isAlive)
    return checkNotNull(result).getOrThrow()
  }

  @Test
  fun `clear and lookup do not wait for a put that is writing`() {
    put("old")
    files.onWrite = {
      otherThread { store.lookup("old") }
      otherThread { store.count }
      otherThread { store.clear() }
    }
    put("new")
    files.onWrite = null
    assertNull(store.lookup("old"))
  }

  @Test
  fun `a put that finishes after a clear is rejected and leaves no file or accounting`() {
    files.onWrite = { otherThread { store.clear() } }
    val result = put("late")
    val rejected = result as PrototypeAssetPutResult.Rejected
    assertEquals(PrototypeAssetRejection.SESSION_ENDED, rejected.reason)
    worker.runAll()
    assertTrue(files.stored.isEmpty())
    assertEquals(0, store.count)
    assertEquals(0L, store.totalByteCount)
    assertNull(store.lookup("late"))
    files.onWrite = null
    assertTrue(put("after") is PrototypeAssetPutResult.Stored)
  }

  @Test
  fun `a replacement that finishes after a clear does not bring the old asset back`() {
    put("hero", 20)
    files.onWrite = { otherThread { store.clear() } }
    assertTrue(put("hero", 30) is PrototypeAssetPutResult.Rejected)
    worker.runAll()
    assertNull(store.lookup("hero"))
    assertTrue(files.stored.isEmpty())
  }

  @Test
  fun `a remove during a replacement write is not resurrected and accounting stays exact`() {
    put("hero", 20)
    files.onWrite = { otherThread { store.remove("hero") } }
    val stored = put("hero", 30) as PrototypeAssetPutResult.Stored
    worker.runAll()
    assertFalse(stored.replaced)
    assertEquals(30L, store.totalByteCount)
    assertEquals(1, store.count)
    assertEquals(1, files.stored.size)
  }

  @Test
  fun `clear resets state at once and leaves the file deletes to the worker`() {
    put("a")
    put("b")
    store.clear()
    assertEquals(0, store.count)
    assertNull(store.lookup("a"))
    assertEquals(2, files.stored.size)
    assertEquals(2, worker.pending)
    worker.runAll()
    assertTrue(files.stored.isEmpty())
  }

  @Test
  fun `remove and replacement deletes also go to the worker`() {
    put("a")
    put("a", 30)
    assertEquals(2, files.stored.size)
    worker.runAll()
    assertEquals(1, files.stored.size)
    store.remove("a")
    assertEquals(1, files.stored.size)
    worker.runAll()
    assertTrue(files.stored.isEmpty())
  }

  @Test
  fun `a failing file delete is logged and does not escape or stop later deletes`() {
    val failing =
      object : PrototypeAssetFiles by files {
        override fun delete(name: String) {
          if (name == "asset-0") throw IllegalStateException("disk gone")
          files.delete(name)
        }
      }
    val flaky = PrototypeAssetStore(failing, limits, fileWorker = worker)
    flaky.put("x", "image/png", PrototypeAssetBytes.png())
    flaky.put("y", "image/png", PrototypeAssetBytes.png())
    flaky.clear()
    worker.runAll()
    assertEquals(0, flaky.count)
    assertEquals(listOf("asset-0"), files.stored.keys.toList()) // only the failed delete remains
  }

  @Test
  fun `assets uploaded in an earlier observer session are gone once a new session starts`() {
    put("a", 70)
    put("b", 70)
    session = 2
    assertNull(store.lookup("a"))
    assertEquals(0, store.count)
    assertEquals(0L, store.totalByteCount)
    assertTrue(store.ids().isEmpty())
    assertNull(store.read("b"))
    worker.runAll()
    assertTrue(files.stored.isEmpty())
  }

  @Test
  fun `a new session's first upload does not count the previous session against the caps`() {
    put("a", 100)
    put("b", 50)
    assertTrue(put("c") is PrototypeAssetPutResult.Rejected) // full: two assets, 150 bytes
    session = 2
    assertTrue(put("c", 100) is PrototypeAssetPutResult.Stored)
    assertEquals(listOf("c"), store.ids())
  }

  @Test
  fun `an upload still writing when the session changes is rejected`() {
    files.onWrite = { session = 2 }
    val result = put("a") as PrototypeAssetPutResult.Rejected
    assertEquals(PrototypeAssetRejection.SESSION_ENDED, result.reason)
    worker.runAll()
    assertTrue(files.stored.isEmpty())
  }

  @Test
  fun `staying in one session keeps assets across calls`() {
    put("a")
    assertEquals("a", store.lookup("a")?.id)
    assertEquals(1, store.count)
    assertEquals(0, worker.pending)
  }

  @Test
  fun `purging leftovers waits for the worker and never touches a committed asset`() {
    files.stored["orphan"] = ByteArray(4)
    store.purgeLeftovers()
    assertEquals(1, worker.pending)
    assertTrue(files.stored.containsKey("orphan"))
    put("a") // the first put purges before writing, so the queued purge finds nothing to do
    worker.runAll()
    assertFalse(files.stored.containsKey("orphan"))
    assertEquals(listOf("a"), store.ids())
    assertEquals(1, files.stored.size)
    assertEquals(1, files.deleteAllCalls)
  }

  private companion object {
    const val JOIN_MS = 5_000L
  }
}
