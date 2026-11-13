package dev.jasonpearson.automobile.sdk.carapp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test

/** Covers the posting seam of [LooperMainThreadRunner] without a main looper. */
class PostedMainThreadRunnerTest {

  @Test
  fun `a block on the main thread runs inline without posting`() {
    val poster = RecordingPoster(currentThread = true)

    assertEquals("inline", runner(poster).run { "inline" })

    assertNull(poster.posted)
    assertNull(poster.cancelled)
  }

  @Test
  fun `a posted block returns its result and is not cancelled`() {
    val poster = RecordingPoster(runPosted = true)

    assertEquals("posted", runner(poster).run { "posted" })

    assertNotNull(poster.posted)
    assertNull(poster.cancelled)
  }

  @Test
  fun `a posted block's failure is rethrown`() {
    val failure = IllegalArgumentException("walk failed")
    val poster = RecordingPoster(runPosted = true)

    val thrown =
      assertThrows(IllegalArgumentException::class.java) {
        runner(poster).run { throw failure }
      }

    assertSame(failure, thrown)
    assertNull(poster.cancelled)
  }

  @Test
  fun `a timed out block is cancelled and reported`() {
    val poster = RecordingPoster()

    val thrown =
      assertThrows(IllegalStateException::class.java) { runner(poster).run { "never runs" } }

    assertEquals(MAIN_THREAD_TIMEOUT, thrown.message)
    // The snapshot nobody waits for any more must not be left queued on the main thread.
    assertSame(poster.posted, poster.cancelled)
    assertNotNull(poster.cancelled)
  }

  @Test
  fun `a refused post is reported and not cancelled`() {
    val poster = RecordingPoster(acceptPost = false)

    val thrown =
      assertThrows(IllegalStateException::class.java) { runner(poster).run { "never runs" } }

    assertEquals(MAIN_THREAD_UNAVAILABLE, thrown.message)
    assertNull(poster.cancelled)
  }

  private fun runner(poster: MainThreadPoster) = PostedMainThreadRunner(poster, timeoutMs = 10L)

  private class RecordingPoster(
    private val currentThread: Boolean = false,
    private val runPosted: Boolean = false,
    private val acceptPost: Boolean = true,
  ) : MainThreadPoster {
    var posted: Runnable? = null
    var cancelled: Runnable? = null

    override fun isCurrentThread(): Boolean = currentThread

    override fun post(task: Runnable): Boolean {
      if (!acceptPost) return false
      posted = task
      if (runPosted) task.run()
      return true
    }

    override fun cancel(task: Runnable) {
      cancelled = task
    }
  }
}
