package dev.jasonpearson.automobile.ctrlproxy.storage

import android.database.ContentObserver
import android.net.Uri
import android.os.Bundle
import android.os.Looper
import dev.jasonpearson.automobile.protocol.StorageChangeEvent
import dev.jasonpearson.automobile.protocol.StorageProtocolSerializer
import dev.jasonpearson.automobile.protocol.StorageResponse
import io.mockk.every
import io.mockk.slot
import io.mockk.verify
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
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
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
internal class StorageSubscriptionManagerEventsTest : StorageSubscriptionManagerFixtures() {
  @Test
  fun `observer only signals instead of calling provider on main looper`() {
    val observer = slot<ContentObserver>()
    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
      Bundle().apply { putBoolean("success", true) }
    every { contentResolver.registerContentObserver(any(), any(), capture(observer)) } returns Unit
    manager.subscribe("com.example.app", "auth")

    observer.captured.dispatchChange(false)
    shadowOf(Looper.getMainLooper()).idle()

    verify(exactly = 0) { contentResolver.call(any<Uri>(), eq("getChanges"), any(), any()) }
  }

  @Test
  fun `storage event bursts retain a bounded latest sequence for gap reconciliation`() =
    runTest(dispatcher) {
      val observerSlot = slot<ContentObserver>()
      val subscribeBundle =
        Bundle().apply {
          putBoolean("success", true)
          putString("result", """{"fileName":"auth","subscribed":true}""")
        }
      val changes =
        (1L..100L).map { sequence ->
          StorageChangeEvent(
            fileName = "auth",
            key = "key-$sequence",
            value = sequence.toString(),
            type = "LONG",
            timestamp = sequence,
            sequenceNumber = sequence,
          )
        }
      val changesBundle =
        Bundle().apply {
          putBoolean("success", true)
          putString(
            "result",
            StorageProtocolSerializer.responseToJson(StorageResponse.Changes("auth", changes)),
          )
        }
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        subscribeBundle
      every { contentResolver.call(any<Uri>(), eq("getChanges"), any(), any()) } returns
        changesBundle
      every { contentResolver.registerContentObserver(any(), any(), capture(observerSlot)) } returns
        Unit

      assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
      observerSlot.captured.onChange(false)
      advanceUntilIdle()

      val received = withTimeout(1_000) { manager.changeEvents.take(64).toList() }
      assertEquals((37L..100L).toList(), received.map { it.sequenceNumber })
    }

  @Test
  fun `one file cannot evict another files latest event`() =
    runTest(dispatcher) {
      val observers = mutableMapOf<String, ContentObserver>()
      val subscribeBundle =
        Bundle().apply {
          putBoolean("success", true)
          putString("result", """{"fileName":"auth","subscribed":true}""")
        }
      fun changesBundle(fileName: String, count: Long) =
        Bundle().apply {
          putBoolean("success", true)
          putString(
            "result",
            StorageProtocolSerializer.responseToJson(
              StorageResponse.Changes(
                fileName,
                (1L..count).map { sequence ->
                  StorageChangeEvent(
                    fileName = fileName,
                    key = "key-$sequence",
                    value = sequence.toString(),
                    type = "LONG",
                    timestamp = sequence,
                    sequenceNumber = sequence,
                  )
                },
              ),
            ),
          )
        }
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        subscribeBundle
      every { contentResolver.call(any<Uri>(), eq("getChanges"), any(), any()) } answers
        {
          val fileName = arg<Bundle>(3).getString("fileName").orEmpty()
          changesBundle(fileName, if (fileName == "target") 1 else 100)
        }
      every { contentResolver.registerContentObserver(any(), any(), any()) } answers
        {
          observers[firstArg<Uri>().authority.orEmpty()] = thirdArg()
        }

      assertTrue(manager.subscribe("com.example.app", "target").isSuccess)
      assertTrue(manager.subscribe("com.example.app", "noisy").isSuccess)
      observers.getValue("com.example.app.automobile.sharedprefs").onChange(false)
      advanceUntilIdle()

      val received = withTimeout(1_000) { manager.changeEvents.take(65).toList() }
      assertEquals(
        listOf(1L),
        received.filter { it.fileName == "target" }.map { it.sequenceNumber },
      )
      assertEquals(
        (37L..100L).toList(),
        received.filter { it.fileName == "noisy" }.map { it.sequenceNumber },
      )
    }

  @Test
  fun `notifyChange fetches on IO rather than the service main looper`() =
    runTest(dispatcher) {
      val provider = RecordingProvider()
      val app = RuntimeEnvironment.getApplication()
      ShadowContentResolver.registerProviderInternal(
        "com.example.app.automobile.sharedprefs",
        provider,
      )
      provider.attachInfo(app, null)
      manager.destroy()
      manager = StorageSubscriptionManager(app, workerDispatcher, this)
      assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
      assertEquals(Looper.getMainLooper(), Looper.myLooper())
      val event = async { manager.changeEvents.first() }

      app.contentResolver.notifyChange(
        Uri.parse("content://com.example.app.automobile.sharedprefs/changes"),
        null,
      )
      shadowOf(Looper.getMainLooper()).idle()

      assertEquals(1L, event.await().sequenceNumber)
      assertTrue(provider.fetchLooper.await() !== Looper.getMainLooper())
      manager.destroy()
      assertTrue(provider.unsubscribeLooper.await() !== Looper.getMainLooper())
    }

  @Test
  fun `destroy drops a fetch that returns after cancellation and closes the event flow`() =
    runTest(dispatcher) {
      val observer = slot<ContentObserver>()
      val release = CompletableDeferred<Unit>()
      var fetchCalls = 0
      val provider = StorageSubscriptionManager.BackgroundCalls { _, method, _ ->
        if (method == "getChanges") {
          fetchCalls++
          withContext(NonCancellable) { release.await() }
          changesBundle("auth", listOf(1L))
        } else Bundle()
      }
      manager.destroy()
      manager = StorageSubscriptionManager(context, dispatcher, this, provider)
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        Bundle().apply { putBoolean("success", true) }
      every { contentResolver.registerContentObserver(any(), any(), capture(observer)) } returns
        Unit
      manager.subscribe("com.example.app", "auth")
      observer.captured.onChange(false)
      runCurrent()
      assertEquals(1, fetchCalls)

      manager.destroy()
      assertTrue(manager.getActiveSubscriptions().isEmpty())
      assertTrue(withTimeout(1_000) { manager.changeEvents.toList() }.isEmpty())
      observer.captured.onChange(false)
      release.complete(Unit)
      advanceUntilIdle()
      assertEquals(1, fetchCalls)
      assertTrue(withTimeout(1_000) { manager.changeEvents.toList() }.isEmpty())
    }

  @Test
  fun `notifications are coalesced and sequence cursors stay ordered`() =
    runTest(dispatcher) {
      val observer = slot<ContentObserver>()
      val release = CompletableDeferred<Unit>()
      val cursors = mutableListOf<Long>()
      val provider = StorageSubscriptionManager.BackgroundCalls { _, method, extras ->
        if (method == "getChanges") {
          cursors += extras.getLong("sinceSequence")
          if (cursors.size == 1) release.await()
          changesBundle("auth", if (cursors.size == 1) listOf(1L, 2L) else listOf(3L))
        } else Bundle()
      }
      manager.destroy()
      manager = StorageSubscriptionManager(context, dispatcher, this, provider)
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        Bundle().apply { putBoolean("success", true) }
      every { contentResolver.registerContentObserver(any(), any(), capture(observer)) } returns
        Unit
      manager.subscribe("com.example.app", "auth")
      observer.captured.onChange(false)
      runCurrent()
      repeat(100) { observer.captured.onChange(false) }
      runCurrent()
      assertEquals(listOf(0L), cursors)
      release.complete(Unit)
      advanceUntilIdle()

      val events = withTimeout(1_000) { manager.changeEvents.take(3).toList() }
      assertEquals(listOf(1L, 2L, 3L), events.map { it.sequenceNumber })
      assertEquals(listOf(0L, 2L), cursors)
      manager.destroy()
      advanceUntilIdle()
    }

  @Test
  fun `late and queued notifications after unsubscribe or destroy make no calls or events`() =
    runTest(dispatcher) {
      val observer = slot<ContentObserver>()
      val events = mutableListOf<PreferenceChangeEvent>()
      val collector = backgroundScope.launch { manager.changeEvents.toList(events) }
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        Bundle().apply { putBoolean("success", true) }
      every { contentResolver.registerContentObserver(any(), any(), capture(observer)) } returns
        Unit
      manager.subscribe("com.example.app", "auth")
      val oldObserver = observer.captured
      oldObserver.onChange(false) // Work queued but not fetched yet.
      assertTrue(manager.unsubscribe("com.example.app", "auth"))
      oldObserver.onChange(false)
      advanceUntilIdle()
      assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
      oldObserver.onChange(false) // Obsolete observer cannot signal the replacement worker.
      advanceUntilIdle()
      observer.captured.onChange(false)
      manager.destroy()
      observer.captured.onChange(false)
      advanceUntilIdle()

      verify(exactly = 0) { contentResolver.call(any<Uri>(), eq("getChanges"), any(), any()) }
      assertTrue(events.isEmpty())
      collector.cancel()
    }

  @Test
  fun `watcher survives provider null pointer and plain runtime failures`() =
    runTest(dispatcher) {
      val observer = slot<ContentObserver>()
      var fetchCalls = 0
      val runtimeFailure = RuntimeException("unclassified provider failure")
      val provider = StorageSubscriptionManager.BackgroundCalls { _, method, _ ->
        if (method == "getChanges") {
          when (++fetchCalls) {
            1 -> throw NullPointerException("provider failed through Binder")
            2 -> throw runtimeFailure
            else -> changesBundle("auth", listOf(1L))
          }
        } else Bundle()
      }
      manager.destroy()
      manager = StorageSubscriptionManager(context, dispatcher, this, provider)
      every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
        Bundle().apply { putBoolean("success", true) }
      every { contentResolver.registerContentObserver(any(), any(), capture(observer)) } returns
        Unit
      manager.subscribe("com.example.app", "auth")
      val events = mutableListOf<PreferenceChangeEvent>()
      backgroundScope.launch { manager.changeEvents.toList(events) }
      runCurrent()

      repeat(3) {
        observer.captured.onChange(false)
        runCurrent()
      }

      assertEquals(3, fetchCalls)
      assertEquals(1, events.size)
      manager.destroy()
    }
}
