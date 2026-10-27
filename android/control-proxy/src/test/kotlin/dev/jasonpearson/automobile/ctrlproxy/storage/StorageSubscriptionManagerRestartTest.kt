package dev.jasonpearson.automobile.ctrlproxy.storage

import android.database.ContentObserver
import android.net.Uri
import android.os.Bundle
import io.mockk.every
import io.mockk.slot
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class StorageSubscriptionManagerRestartTest : StorageSubscriptionManagerFixtures() {
  @Test
  fun `re-subscribing after the app restarts resets the cursor so the new process is heard`() =
    runTest(dispatcher) {
      val observerSlot = slot<ContentObserver>()
      val requestedSince = mutableListOf<Long>()
      every { contentResolver.registerContentObserver(any(), any(), capture(observerSlot)) } returns
        Unit
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        tokenSubscribeBundle("process-a")
      assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)

      // Old process: five changes delivered, cursor advances to 5.
      fakeAppProcess("process-a", (1L..5L).toList(), requestedSince)
      observerSlot.captured.onChange(false)
      advanceUntilIdle()
      assertEquals(
        (1L..5L).toList(),
        withTimeout(1_000) { manager.changeEvents.take(5).toList() }.map { it.sequenceNumber },
      )

      // The app is relaunched: new token, counter restarts, changes numbered from 1.
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        tokenSubscribeBundle("process-b")
      assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
      requestedSince.clear()
      fakeAppProcess("process-b", listOf(1L, 2L, 3L), requestedSince)
      observerSlot.captured.onChange(false)
      advanceUntilIdle()

      assertEquals(listOf(0L), requestedSince)
      assertEquals(
        listOf(1L, 2L, 3L),
        withTimeout(1_000) { manager.changeEvents.take(3).toList() }.map { it.sequenceNumber },
      )
    }

  @Test
  fun `a changes reply from a different process resets the cursor and re-reads from zero`() =
    runTest(dispatcher) {
      val observerSlot = slot<ContentObserver>()
      val requestedSince = mutableListOf<Long>()
      every { contentResolver.registerContentObserver(any(), any(), capture(observerSlot)) } returns
        Unit
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        tokenSubscribeBundle("process-a")
      assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
      fakeAppProcess("process-a", (1L..5L).toList(), requestedSince)
      observerSlot.captured.onChange(false)
      advanceUntilIdle()
      withTimeout(1_000) { manager.changeEvents.take(5).toList() }

      // No re-subscribe: the first notification after the restart already reveals the new token,
      // and the manager re-arms the new process's listener itself.
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        tokenSubscribeBundle("process-b")
      requestedSince.clear()
      fakeAppProcess("process-b", listOf(1L, 2L, 3L), requestedSince)
      observerSlot.captured.onChange(false)
      advanceUntilIdle()

      assertEquals(listOf(5L, 0L), requestedSince)
      assertEquals(
        listOf(1L, 2L, 3L),
        withTimeout(1_000) { manager.changeEvents.take(3).toList() }.map { it.sequenceNumber },
      )
    }

  /**
   * A fake app that, like the real SDK's `drainAfter`, REMOVES the changes it returns.
   * [requestedSince] records the cursor of every call; [failRequestsWithSince] simulates a provider
   * failure for requests with that cursor.
   */
  @Test
  fun `a restart seen by the poll still delivers the changes the stale-cursor read drained`() =
    runTest(dispatcher) {
      val observerSlot = slot<ContentObserver>()
      val requestedSince = mutableListOf<Long>()
      every { contentResolver.registerContentObserver(any(), any(), capture(observerSlot)) } returns
        Unit
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        tokenSubscribeBundle("process-a")
      assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
      drainingAppProcess("process-a", mutableListOf(1L, 2L, 3L), requestedSince)
      observerSlot.captured.onChange(false)
      advanceUntilIdle()
      withTimeout(1_000) { manager.changeEvents.take(3).toList() }

      // Old cursor is 3; the new process recorded 1..5 before the next poll. The cursor-3 read
      // drains 4 and 5, then the re-read from 0 returns only 1..3.
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        tokenSubscribeBundle("process-b")
      requestedSince.clear()
      drainingAppProcess("process-b", mutableListOf(1L, 2L, 3L, 4L, 5L), requestedSince)
      observerSlot.captured.onChange(false)
      advanceUntilIdle()

      assertEquals(listOf(3L, 0L), requestedSince)
      assertEquals(
        listOf(1L, 2L, 3L, 4L, 5L),
        withTimeout(1_000) { manager.changeEvents.take(5).toList() }.map { it.sequenceNumber },
      )
    }

  @Test
  fun `a second restart during the re-arm drops the dead process reply instead of advancing the cursor`() =
    runTest(dispatcher) {
      val observerSlot = slot<ContentObserver>()
      val requestedSince = mutableListOf<Long>()
      every { contentResolver.registerContentObserver(any(), any(), capture(observerSlot)) } returns
        Unit
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        tokenSubscribeBundle("process-a")
      assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
      drainingAppProcess("process-a", mutableListOf(1L, 2L, 3L), requestedSince)
      observerSlot.captured.onChange(false)
      advanceUntilIdle()
      withTimeout(1_000) { manager.changeEvents.take(3).toList() }

      // The cursor read is answered by process-b (sequences 7, 8) but the app restarts again before
      // the re-arm, which reaches process-c, whose counter is back at 1.
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        tokenSubscribeBundle("process-c")
      requestedSince.clear()
      every { contentResolver.call(any<Uri>(), eq("getChanges"), any(), any()) } answers
        {
          val since = arg<Bundle>(3).getLong("sinceSequence", 0L)
          requestedSince.add(since)
          if (since == 0L) tokenChangesBundle("process-c", listOf(1L, 2L))
          else tokenChangesBundle("process-b", listOf(7L, 8L))
        }
      observerSlot.captured.onChange(false)
      advanceUntilIdle()

      assertEquals(listOf(3L, 0L), requestedSince)
      assertEquals(
        listOf(1L, 2L),
        withTimeout(1_000) { manager.changeEvents.take(2).toList() }.map { it.sequenceNumber },
      )

      // The cursor sits at 2, not 8, so process-c's next change is heard.
      requestedSince.clear()
      drainingAppProcess("process-c", mutableListOf(3L), requestedSince)
      observerSlot.captured.onChange(false)
      advanceUntilIdle()
      assertEquals(listOf(2L), requestedSince)
      assertEquals(
        listOf(3L),
        withTimeout(1_000) { manager.changeEvents.take(1).toList() }.map { it.sequenceNumber },
      )
    }

  @Test
  fun `a failed re-read after a restart keeps the cursor at zero so the rest is read next poll`() =
    runTest(dispatcher) {
      val observerSlot = slot<ContentObserver>()
      val requestedSince = mutableListOf<Long>()
      every { contentResolver.registerContentObserver(any(), any(), capture(observerSlot)) } returns
        Unit
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        tokenSubscribeBundle("process-a")
      assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
      drainingAppProcess("process-a", mutableListOf(1L, 2L, 3L), requestedSince)
      observerSlot.captured.onChange(false)
      advanceUntilIdle()
      withTimeout(1_000) { manager.changeEvents.take(3).toList() }

      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        tokenSubscribeBundle("process-b")
      requestedSince.clear()
      val queue = mutableListOf(1L, 2L, 3L, 4L, 5L)
      drainingAppProcess("process-b", queue, requestedSince, failRequestsWithSince = 0L)
      observerSlot.captured.onChange(false)
      advanceUntilIdle()
      // The first reply's 4 and 5 are delivered; 1..3 are still queued in the app.
      assertEquals(
        listOf(4L, 5L),
        withTimeout(1_000) { manager.changeEvents.take(2).toList() }.map { it.sequenceNumber },
      )

      requestedSince.clear()
      drainingAppProcess("process-b", queue, requestedSince)
      observerSlot.captured.onChange(false)
      advanceUntilIdle()

      assertEquals(listOf(0L), requestedSince)
      assertEquals(
        listOf(1L, 2L, 3L),
        withTimeout(1_000) { manager.changeEvents.take(3).toList() }.map { it.sequenceNumber },
      )
    }

  @Test
  fun `re-subscribing to the same process keeps the cursor`() =
    runTest(dispatcher) {
      val observerSlot = slot<ContentObserver>()
      val requestedSince = mutableListOf<Long>()
      every { contentResolver.registerContentObserver(any(), any(), capture(observerSlot)) } returns
        Unit
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        tokenSubscribeBundle("process-a")
      assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
      fakeAppProcess("process-a", (1L..5L).toList(), requestedSince)
      observerSlot.captured.onChange(false)
      advanceUntilIdle()
      withTimeout(1_000) { manager.changeEvents.take(5).toList() }

      assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
      requestedSince.clear()
      observerSlot.captured.onChange(false)
      advanceUntilIdle()

      assertEquals(listOf(5L), requestedSince)
    }

  @Test
  fun `a failed re-subscribe reports the failure and keeps the existing entry`() {
    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
      tokenSubscribeBundle("process-a")
    assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)

    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
      Bundle().apply {
        putBoolean("success", false)
        putString("error", "provider unavailable")
      }
    val retried = manager.subscribe("com.example.app", "auth")

    assertTrue(retried.exceptionOrNull() is StorageError.SdkError)
    assertEquals(1, manager.getActiveSubscriptions().size)
  }
}
