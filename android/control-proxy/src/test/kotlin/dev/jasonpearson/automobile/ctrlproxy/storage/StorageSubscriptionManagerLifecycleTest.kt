package dev.jasonpearson.automobile.ctrlproxy.storage

import android.database.ContentObserver
import android.net.Uri
import android.os.Bundle
import android.os.Looper
import io.mockk.every
import io.mockk.slot
import io.mockk.verify
import java.util.concurrent.TimeUnit.SECONDS
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
internal class StorageSubscriptionManagerLifecycleTest : StorageSubscriptionManagerFixtures() {
  @Test
  fun `destroy clears local state without synchronously calling provider`() {
    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
      Bundle().apply { putBoolean("success", true) }
    manager.subscribe("com.example.app", "auth")

    manager.destroy()

    assertTrue(manager.getActiveSubscriptions().isEmpty())
    verify { contentResolver.unregisterContentObserver(any()) }
    verify(exactly = 0) {
      contentResolver.call(any<Uri>(), eq("unsubscribeFromFile"), any(), any())
    }
  }

  // ================= Unsubscribe Tests =================

  @Test
  fun `unsubscribe returns true when subscribed`() {
    val subscribeBundle =
      Bundle().apply {
        putBoolean("success", true)
        putString("result", """{"fileName":"auth","subscribed":true}""")
      }
    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
      subscribeBundle
    every { contentResolver.call(any<Uri>(), eq("unsubscribeFromFile"), any(), any()) } returns
      Bundle()

    manager.subscribe("com.example.app", "auth")
    val result = manager.unsubscribe("com.example.app", "auth")

    assertTrue(result)
  }

  @Test
  fun `unsubscribe is idempotent when not subscribed`() {
    val result = manager.unsubscribe("com.example.app", "nonexistent")

    assertTrue(result)
  }

  @Test
  fun `unsubscribe unregisters ContentObserver when no more subscriptions for package`() {
    val subscribeBundle =
      Bundle().apply {
        putBoolean("success", true)
        putString("result", """{"subscribed":true}""")
      }
    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
      subscribeBundle
    every { contentResolver.call(any<Uri>(), eq("unsubscribeFromFile"), any(), any()) } returns
      Bundle()

    manager.subscribe("com.example.app", "auth")
    manager.unsubscribe("com.example.app", "auth")

    verify { contentResolver.unregisterContentObserver(any()) }
  }

  @Test
  fun `unsubscribe drops an in-flight fetch even after resubscribe`() =
    runTest(dispatcher) {
      val observer = slot<ContentObserver>()
      val releaseFetch = CompletableDeferred<Unit>()
      val fetchEntered = CompletableDeferred<Unit>()
      var calls = 0
      val provider = StorageSubscriptionManager.BackgroundCalls { _, method, extras ->
        if (method == "getChanges" && extras.getString("fileName") == "auth") {
          calls++
          if (calls == 1) {
            fetchEntered.complete(Unit)
            // Model Binder ignoring interruption, then release it explicitly without a real thread.
            withContext(NonCancellable) { releaseFetch.await() }
          }
          changesBundle("auth", listOf(calls.toLong()))
        } else Bundle()
      }
      manager.destroy()
      manager = StorageSubscriptionManager(context, dispatcher, this, provider)
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        Bundle().apply { putBoolean("success", true) }
      every { contentResolver.registerContentObserver(any(), any(), capture(observer)) } returns
        Unit
      assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
      // Keep the package worker alive: dropping the old result must use subscription identity.
      assertTrue(manager.subscribe("com.example.app", "settings").isSuccess)
      observer.captured.onChange(false)
      runCurrent()
      fetchEntered.await()

      assertTrue(manager.unsubscribe("com.example.app", "auth"))
      assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
      releaseFetch.complete(Unit)
      advanceUntilIdle()
      observer.captured.onChange(false)
      advanceUntilIdle()

      val received = withTimeout(1_000) { manager.changeEvents.take(1).toList() }
      assertEquals(listOf(2L), received.map { it.sequenceNumber })
      manager.destroy()
      advanceUntilIdle()
    }

  // ================= Active Subscriptions Tests =================

  @Test
  fun `getActiveSubscriptions returns empty list initially`() {
    val subscriptions = manager.getActiveSubscriptions()

    assertTrue(subscriptions.isEmpty())
  }

  @Test
  fun `getActiveSubscriptions returns all active subscriptions`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        putString("result", """{"subscribed":true}""")
      }
    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns bundle

    manager.subscribe("com.example.app1", "auth")
    manager.subscribe("com.example.app2", "settings")

    val subscriptions = manager.getActiveSubscriptions()

    assertEquals(2, subscriptions.size)
    assertTrue(subscriptions.any { it.subscriptionId == "com.example.app1:auth" })
    assertTrue(subscriptions.any { it.subscriptionId == "com.example.app2:settings" })
  }

  // ================= Destroy Tests =================

  @Test
  fun `destroy clears all subscriptions`() {
    val subscribeBundle =
      Bundle().apply {
        putBoolean("success", true)
        putString("result", """{"subscribed":true}""")
      }
    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
      subscribeBundle
    every { contentResolver.call(any<Uri>(), eq("unsubscribeFromFile"), any(), any()) } returns
      Bundle()

    manager.subscribe("com.example.app", "auth")
    manager.subscribe("com.example.app", "settings")

    manager.destroy()

    assertTrue(manager.getActiveSubscriptions().isEmpty())
  }

  @Test
  fun `destroy unsubscribes on IO even after the owning scope is cancelled`() =
    runTest(dispatcher) {
      val provider = RecordingProvider()
      val app = RuntimeEnvironment.getApplication()
      ShadowContentResolver.registerProviderInternal(
        "com.example.app.automobile.sharedprefs",
        provider,
      )
      provider.attachInfo(app, null)
      val owner = TestScope(dispatcher)
      manager.destroy()
      manager = StorageSubscriptionManager(app, workerDispatcher, owner)
      assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
      owner.cancel()

      manager.destroy()

      assertTrue(manager.getActiveSubscriptions().isEmpty())
      assertTrue(provider.unsubscribeLooper.await() !== Looper.getMainLooper())
    }

  @Test
  fun `destroy bounds cleanup and clears local state even when provider ignores cancellation`() =
    runTest(dispatcher) {
      val release = CompletableDeferred<Unit>()
      val entered = CompletableDeferred<Unit>()
      val returned = CompletableDeferred<Unit>()
      var calls = 0
      val provider = StorageSubscriptionManager.BackgroundCalls { _, method, _ ->
        assertEquals("unsubscribeFromFile", method)
        calls++
        entered.complete(Unit)
        // NonCancellable models a Binder call ignoring interruption, but the test always releases
        // it.
        withContext(NonCancellable) { release.await() }
        returned.complete(Unit)
        Bundle()
      }
      manager.destroy()
      manager =
        StorageSubscriptionManager(
          context = context,
          ioDispatcher = dispatcher,
          scope = this,
          backgroundCalls = provider,
          config =
            StorageSubscriptionConfig(
              cleanupTimeoutMs = 100,
            ),
        )
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        Bundle().apply { putBoolean("success", true) }
      manager.subscribe("com.example.app", "auth")
      manager.subscribe("com.example.app", "settings")

      manager.destroy()
      assertTrue(manager.getActiveSubscriptions().isEmpty())
      verify { contentResolver.unregisterContentObserver(any()) }
      val initialTime = testScheduler.currentTime
      runCurrent()
      entered.await()
      advanceUntilIdle()
      assertEquals(100L, testScheduler.currentTime - initialTime)
      assertEquals(1, calls)
      assertTrue(!returned.isCompleted)
      manager.destroy() // No duplicate cleanup.
      release.complete(Unit)
      advanceUntilIdle()
      assertTrue(returned.isCompleted)
      assertEquals(1, calls)
    }

  @Test
  fun `concurrent subscribe unsubscribe and iteration do not corrupt state`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        putString("result", """{"subscribed":true}""")
      }
    every { contentResolver.call(any<Uri>(), any(), any(), any()) } returns bundle

    val threadCount = 8
    val perThread = 200
    val errors = java.util.concurrent.CopyOnWriteArrayList<Throwable>()
    val latch = java.util.concurrent.CountDownLatch(threadCount)

    // All threads target the same package (shared packageObservers entry + nested
    // file set) with unique file names, hammering the maps concurrently. Under a
    // plain HashMap this trips ConcurrentModificationException / a corrupted map
    // (#3600); with ConcurrentHashMap it stays consistent.
    for (t in 0 until threadCount) {
      Thread {
        try {
          for (i in 0 until perThread) {
            val file = "file-$t-$i"
            manager.subscribe("com.example.app", file)
            manager.getActiveSubscriptions() // iterate while others mutate
            manager.unsubscribe("com.example.app", file)
          }
        } catch (e: Throwable) {
          errors.add(e)
        } finally {
          latch.countDown()
        }
      }
        .start()
    }

    assertTrue(
      "concurrent access timed out",
      latch.await(30, java.util.concurrent.TimeUnit.SECONDS),
    )
    assertTrue("concurrent access threw: ${errors.firstOrNull()}", errors.isEmpty())
    // Every subscribe (unique id) was matched by an unsubscribe.
    assertTrue(manager.getActiveSubscriptions().isEmpty())
  }

  @Test
  fun `concurrent first subscribe registers exactly one observer per package`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        putString("result", """{"subscribed":true}""")
      }
    every { contentResolver.call(any<Uri>(), any(), any(), any()) } returns bundle

    val observers =
      java.util.concurrent.ConcurrentHashMap.newKeySet<android.database.ContentObserver>()
    every { contentResolver.registerContentObserver(any(), any(), any()) } answers
      {
        observers += thirdArg<android.database.ContentObserver>()
      }

    val threadCount = 12
    val barrier = java.util.concurrent.CyclicBarrier(threadCount)
    val errors = java.util.concurrent.CopyOnWriteArrayList<Throwable>()
    val latch = java.util.concurrent.CountDownLatch(threadCount)

    // All threads race to first-subscribe DISTINCT files of the SAME package, aligned
    // on a barrier to maximize contention on the initial packageObservers entry. The
    // package observer must be created exactly once and every file merged into it; a
    // non-atomic check-then-put lets two callers both see no entry, register separate
    // observers, and overwrite the map with single-file state — leaking the losing
    // observer and dropping its file (Codex #4709 review). The atomic compute fix keeps
    // exactly one observer for the package.
    for (t in 0 until threadCount) {
      Thread {
        try {
          barrier.await()
          manager.subscribe("com.example.app", "file-$t")
        } catch (e: Throwable) {
          errors.add(e)
        } finally {
          latch.countDown()
        }
      }
        .start()
    }

    assertTrue(
      "concurrent subscribe timed out",
      latch.await(30, java.util.concurrent.TimeUnit.SECONDS),
    )
    assertTrue("concurrent subscribe threw: ${errors.firstOrNull()}", errors.isEmpty())
    // Exactly one ContentObserver for the single package — no leaked duplicates.
    assertEquals(1, observers.size)
    // Every distinct file's subscription is live and merged under that one observer.
    assertEquals(threadCount, manager.getActiveSubscriptions().size)
  }
}
