package dev.jasonpearson.automobile.ctrlproxy.storage

import android.content.ContentProvider
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.database.ContentObserver
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.os.Looper
import dev.jasonpearson.automobile.protocol.StorageChangeEvent
import dev.jasonpearson.automobile.protocol.StorageProtocolSerializer
import dev.jasonpearson.automobile.protocol.StorageResponse
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
class StorageSubscriptionManagerTest {

  private lateinit var context: Context
  private lateinit var contentResolver: ContentResolver
  private lateinit var manager: StorageSubscriptionManager
  private val dispatcher = StandardTestDispatcher()
  private val scope = TestScope(dispatcher)

  @Before
  fun setUp() {
    contentResolver = mockk(relaxed = true)
    context = mockk(relaxed = true)
    every { context.contentResolver } returns contentResolver
    manager = StorageSubscriptionManager(context, dispatcher, scope)
  }

  @After
  fun tearDown() {
    manager.destroy()
    scope.testScheduler.advanceUntilIdle()
    scope.cancel()
  }

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

  // ================= SDK Availability Tests =================

  @Test
  fun `checkSdkAvailability returns failure when SDK not installed`() {
    every { contentResolver.call(any<Uri>(), any(), any(), any()) } returns null

    val result = manager.checkSdkAvailability("com.example.app")

    assertTrue(result.isFailure)
    assertTrue(result.exceptionOrNull() is StorageError.SdkNotInstalled)
  }

  @Test
  fun `checkSdkAvailability returns failure when inspection disabled`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", false)
        putString("errorType", "DISABLED")
        putString("error", "Inspection is disabled")
      }
    every { contentResolver.call(any<Uri>(), eq("checkAvailability"), any(), any()) } returns bundle

    val result = manager.checkSdkAvailability("com.example.app")

    assertTrue(result.isFailure)
    assertTrue(result.exceptionOrNull() is StorageError.InspectionDisabled)
  }

  @Test
  fun `checkSdkAvailability returns success with version info`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        // Response uses kotlinx.serialization sealed class format with type discriminator
        putString("result", """{"type":"availability","available":true,"version":1}""")
      }
    every { contentResolver.call(any<Uri>(), eq("checkAvailability"), any(), any()) } returns bundle

    val result = manager.checkSdkAvailability("com.example.app")

    assertTrue(result.isSuccess)
    val info = result.getOrNull()!!
    assertTrue(info.available)
    assertEquals(1, info.version)
  }

  // ================= List Preference Files Tests =================

  @Test
  fun `listPreferenceFiles returns files on success`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        // Response uses kotlinx.serialization sealed class format with type discriminator
        putString(
          "result",
          """{"type":"files","files":[{"name":"auth","path":"/data/auth.xml","entryCount":5},{"name":"settings","path":"/data/settings.xml","entryCount":3}]}""",
        )
      }
    every { contentResolver.call(any<Uri>(), eq("listFiles"), any(), any()) } returns bundle

    val result = manager.listPreferenceFiles("com.example.app")

    assertTrue(result.isSuccess)
    val files = result.getOrNull()!!
    assertEquals(2, files.size)
    assertEquals("auth", files[0].name)
    assertEquals(5, files[0].entryCount)
    assertEquals("settings", files[1].name)
    assertEquals(3, files[1].entryCount)
  }

  @Test
  fun `listPreferenceFiles returns failure when SDK not installed`() {
    every { contentResolver.call(any<Uri>(), eq("listFiles"), any(), any()) } returns null

    val result = manager.listPreferenceFiles("com.example.app")

    assertTrue(result.isFailure)
    assertTrue(result.exceptionOrNull() is StorageError.SdkNotInstalled)
  }

  // ================= Get Preferences Tests =================

  @Test
  fun `getPreferences returns entries on success`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        // Response uses kotlinx.serialization sealed class format with type discriminator
        putString(
          "result",
          """{"type":"preferences","entries":[{"key":"username","value":"john","type":"STRING"},{"key":"count","value":"42","type":"INT"}]}""",
        )
      }
    every { contentResolver.call(any<Uri>(), eq("getPreferences"), any(), any()) } returns bundle

    val result = manager.getPreferences("com.example.app", "auth")

    assertTrue(result.isSuccess)
    val entries = result.getOrNull()!!
    assertEquals(2, entries.size)
    assertEquals("username", entries[0].key)
    assertEquals("john", entries[0].value)
    assertEquals("STRING", entries[0].type)
    assertEquals("count", entries[1].key)
    assertEquals("42", entries[1].value)
    assertEquals("INT", entries[1].type)
  }

  @Test
  fun `getPreferences returns failure for missing file`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", false)
        putString("errorType", "FileNotFound")
        putString("error", "File not found")
      }
    every { contentResolver.call(any<Uri>(), eq("getPreferences"), any(), any()) } returns bundle

    val result = manager.getPreferences("com.example.app", "nonexistent")

    assertTrue(result.isFailure)
    assertTrue(result.exceptionOrNull() is StorageError.FileNotFound)
  }

  // ================= DataStore Tests =================

  @Test
  fun `listDataStores returns descriptors and passes adapterName`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        // DataStore descriptors reuse the shared FileList shape (path emitted empty).
        putString(
          "result",
          """{"type":"files","files":[{"name":"user_prefs","path":"","entryCount":2}]}""",
        )
      }
    val extrasSlot = slot<Bundle>()
    every {
      contentResolver.call(any<Uri>(), eq("listDataStores"), any(), capture(extrasSlot))
    } returns bundle

    val result = manager.listDataStores("com.example.app", "settings")

    assertTrue(result.isSuccess)
    val files = result.getOrNull()!!
    assertEquals(1, files.size)
    assertEquals("user_prefs", files[0].name)
    assertEquals(2, files[0].entryCount)
    assertEquals("settings", extrasSlot.captured.getString("adapterName"))
  }

  @Test
  fun `listDataStores returns failure when SDK not installed`() {
    every { contentResolver.call(any<Uri>(), eq("listDataStores"), any(), any()) } returns null

    val result = manager.listDataStores("com.example.app", "settings")

    assertTrue(result.isFailure)
    assertTrue(result.exceptionOrNull() is StorageError.SdkNotInstalled)
  }

  @Test
  fun `getDataStore returns entries and passes adapterName and storeName`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        putString(
          "result",
          """{"type":"preferences","entries":[{"key":"theme","value":"dark","type":"STRING"}]}""",
        )
      }
    val extrasSlot = slot<Bundle>()
    every {
      contentResolver.call(any<Uri>(), eq("getDataStore"), any(), capture(extrasSlot))
    } returns bundle

    val result = manager.getDataStore("com.example.app", "settings", "user_prefs")

    assertTrue(result.isSuccess)
    val entries = result.getOrNull()!!
    assertEquals(1, entries.size)
    assertEquals("theme", entries[0].key)
    assertEquals("dark", entries[0].value)
    assertEquals("STRING", entries[0].type)
    assertEquals("settings", extrasSlot.captured.getString("adapterName"))
    assertEquals("user_prefs", extrasSlot.captured.getString("storeName"))
  }

  @Test
  fun `getDataStore maps StoreNotFound to FileNotFound`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", false)
        putString("errorType", "StoreNotFound")
        putString("error", "Store not found")
      }
    every { contentResolver.call(any<Uri>(), eq("getDataStore"), any(), any()) } returns bundle

    val result = manager.getDataStore("com.example.app", "settings", "missing")

    assertTrue(result.isFailure)
    assertTrue(result.exceptionOrNull() is StorageError.FileNotFound)
  }

  // ================= Subscribe Tests =================

  @Test
  fun `subscribe returns subscription on success`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        putString("result", """{"fileName":"auth","subscribed":true}""")
      }
    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns bundle

    val result = manager.subscribe("com.example.app", "auth")

    assertTrue(result.isSuccess)
    val subscription = result.getOrNull()!!
    assertEquals("com.example.app", subscription.packageName)
    assertEquals("auth", subscription.fileName)
    assertEquals("com.example.app:auth", subscription.subscriptionId)
  }

  @Test
  fun `subscribe returns same subscription when already subscribed and re-arms the app`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        putString("result", """{"fileName":"auth","subscribed":true}""")
      }
    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns bundle

    // Subscribe twice
    val result1 = manager.subscribe("com.example.app", "auth")
    val result2 = manager.subscribe("com.example.app", "auth")

    assertTrue(result1.isSuccess)
    assertTrue(result2.isSuccess)
    assertEquals(result1.getOrNull()?.subscriptionId, result2.getOrNull()?.subscriptionId)

    // The app-side listener dies with the app process, so a repeat subscribe must re-arm it even
    // though the local entry is reused (#10069). The SDK treats the repeat as a no-op.
    verify(exactly = 2) { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) }
    verify(exactly = 1) { contentResolver.registerContentObserver(any(), any(), any()) }
  }

  @Test
  fun `subscribe registers ContentObserver`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        putString("result", """{"fileName":"auth","subscribed":true}""")
      }
    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns bundle

    manager.subscribe("com.example.app", "auth")

    verify {
      contentResolver.registerContentObserver(
        match { it.toString().contains("com.example.app.automobile.sharedprefs") },
        any(),
        any(),
      )
    }
  }

  @Test
  fun `subscribe rolls back failed observer registration so a later attempt can succeed`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        putString("result", """{"fileName":"auth","subscribed":true}""")
      }
    var failRegistration = true
    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns bundle
    every { contentResolver.registerContentObserver(any(), any(), any()) } answers
      {
        if (failRegistration) {
          throw SecurityException("observer registration denied")
        }
      }

    val failed = manager.subscribe("com.example.app", "auth")

    assertTrue(failed.isFailure)
    assertTrue(manager.getActiveSubscriptions().isEmpty())

    failRegistration = false
    val retried = manager.subscribe("com.example.app", "auth")

    assertTrue(retried.isSuccess)
    assertEquals(
      listOf("com.example.app:auth"),
      manager.getActiveSubscriptions().map { it.subscriptionId },
    )
  }

  @Test
  fun `failed concurrent acquisition cannot roll back a successful subscription`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        putString("result", """{"fileName":"auth","subscribed":true}""")
      }
    val firstRegistrationEntered = java.util.concurrent.CountDownLatch(1)
    val releaseFirstRegistration = java.util.concurrent.CountDownLatch(1)
    val registrationCalls = java.util.concurrent.atomic.AtomicInteger()
    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns bundle
    every { contentResolver.registerContentObserver(any(), any(), any()) } answers
      {
        if (registrationCalls.getAndIncrement() == 0) {
          firstRegistrationEntered.countDown()
          assertTrue(releaseFirstRegistration.await(1, java.util.concurrent.TimeUnit.SECONDS))
          throw SecurityException("first registration denied")
        }
      }

    var firstResult: Result<StorageSubscription>? = null
    var secondResult: Result<StorageSubscription>? = null
    val first = Thread { firstResult = manager.subscribe("com.example.app", "auth") }
    first.start()
    assertTrue(firstRegistrationEntered.await(1, java.util.concurrent.TimeUnit.SECONDS))
    val second = Thread { secondResult = manager.subscribe("com.example.app", "auth") }
    second.start()
    releaseFirstRegistration.countDown()
    first.join(1_000)
    second.join(1_000)

    assertTrue(firstResult?.isFailure == true)
    assertTrue(secondResult?.isSuccess == true)
    assertEquals(
      listOf("com.example.app:auth"),
      manager.getActiveSubscriptions().map { it.subscriptionId },
    )
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
              )
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

  // ================= Inspected app restart (#10069) =================

  private fun tokenSubscribeBundle(token: String?) =
    Bundle().apply {
      putBoolean("success", true)
      putString(
        "result",
        StorageProtocolSerializer.responseToJson(
          StorageResponse.SubscriptionResult("auth", subscribed = true, processToken = token)
        ),
      )
    }

  private fun tokenChangesBundle(token: String?, sequences: List<Long>) =
    Bundle().apply {
      putBoolean("success", true)
      putString(
        "result",
        StorageProtocolSerializer.responseToJson(
          StorageResponse.Changes(
            "auth",
            sequences.map { sequence ->
              StorageChangeEvent(
                fileName = "auth",
                key = "key-$sequence",
                value = sequence.toString(),
                type = "LONG",
                timestamp = sequence,
                sequenceNumber = sequence,
              )
            },
            processToken = token,
          )
        ),
      )
    }

  /** A fake app: replies to `getChanges` by applying the real SDK's `sequence > since` filter. */
  private fun fakeAppProcess(
    token: String?,
    queued: List<Long>,
    requestedSince: MutableList<Long>,
  ) {
    every { contentResolver.call(any<Uri>(), eq("getChanges"), any(), any()) } answers
      {
        val since = arg<Bundle>(3).getLong("sinceSequence", 0L)
        requestedSince.add(since)
        tokenChangesBundle(token, queued.filter { it > since })
      }
  }

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
  private fun drainingAppProcess(
    token: String,
    queue: MutableList<Long>,
    requestedSince: MutableList<Long>,
    failRequestsWithSince: Long? = null,
  ) {
    every { contentResolver.call(any<Uri>(), eq("getChanges"), any(), any()) } answers
      {
        val since = arg<Bundle>(3).getLong("sinceSequence", 0L)
        requestedSince.add(since)
        if (since == failRequestsWithSince) {
          Bundle().apply {
            putBoolean("success", false)
            putString("error", "provider unavailable")
          }
        } else {
          val drained = queue.filter { it > since }
          queue.removeAll(drained.toSet())
          tokenChangesBundle(token, drained)
        }
      }
  }

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

  // ================= Open subscription survives an app restart (#10069) =================

  /**
   * A fake inspected app process. Like the real SDK it removes the changes it returns, restarts its
   * sequence counter with a new process token, and records a change only while its listener is
   * armed by `subscribeToFile` — a restart disarms it.
   */
  private inner class FakeInspectedApp(var token: String) {
    var present = true
    var armed = false
    var failNextSubscribe = false
    val calls = mutableListOf<String>()
    private var counter = 0L
    private val queue = mutableListOf<Long>()

    fun restart(newToken: String) {
      token = newToken
      armed = false
      counter = 0
      queue.clear()
    }

    /** A preference write; lost to the inspector when the listener is not armed. */
    fun write(count: Int = 1) {
      if (!armed) return
      repeat(count) { queue.add(++counter) }
    }

    fun handle(method: String, since: Long): Bundle? {
      calls.add(method)
      if (!present) return null
      return when (method) {
        "subscribeToFile" ->
          if (failNextSubscribe) {
            failNextSubscribe = false
            Bundle().apply {
              putBoolean("success", false)
              putString("error", "provider unavailable")
            }
          } else {
            armed = true
            tokenSubscribeBundle(token)
          }
        "getChanges" -> {
          val drained = queue.filter { it > since }
          queue.removeAll(drained.toSet())
          tokenChangesBundle(token, drained)
        }
        else -> null
      }
    }

    fun count(method: String): Int = calls.count { it == method }
  }

  private fun wireApp(app: FakeInspectedApp): ContentObserver {
    val observerSlot = slot<ContentObserver>()
    every { contentResolver.registerContentObserver(any(), any(), capture(observerSlot)) } returns
      Unit
    every { contentResolver.call(any<Uri>(), any<String>(), any(), any()) } answers
      {
        app.handle(arg<String>(1), arg<Bundle?>(3)?.getLong("sinceSequence", 0L) ?: 0L)
      }
    assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
    return observerSlot.captured
  }

  private suspend fun nextSequences(count: Int): List<Long> =
    withTimeout(1_000) { manager.changeEvents.take(count).toList() }.map { it.sequenceNumber }

  @Test
  fun `an open subscription re-arms itself after the app restarts without a re-subscribe`() =
    runTest(dispatcher) {
      val app = FakeInspectedApp("process-a")
      val observer = wireApp(app)
      app.write(2)
      observer.onChange(false)
      advanceUntilIdle()
      assertEquals(listOf(1L, 2L), nextSequences(2))

      // terminateApp + launchApp: new process, listener gone. The client does nothing.
      app.restart("process-b")
      app.write(1) // made before the re-arm: the new process cannot report it
      manager.onPackageActivity("com.example.app")
      advanceUntilIdle()

      assertTrue(app.armed)
      assertEquals(2, app.count("subscribeToFile"))
      app.write(3)
      observer.onChange(false)
      advanceUntilIdle()
      assertEquals(listOf(1L, 2L, 3L), nextSequences(3))
      // Nothing is delivered twice.
      assertEquals(null, withTimeoutOrNull(1_000) { manager.changeEvents.first() })
      assertEquals(2, app.count("subscribeToFile"))
    }

  @Test
  fun `an app that is not running keeps the subscription and re-arms when it returns`() =
    runTest(dispatcher) {
      val app = FakeInspectedApp("process-a")
      val observer = wireApp(app)
      app.write(1)
      observer.onChange(false)
      advanceUntilIdle()
      assertEquals(listOf(1L), nextSequences(1))

      // Uninstalled / not running: every provider call fails and nothing re-arms or crashes.
      app.present = false
      app.restart("process-b")
      manager.onPackageActivity("com.example.app")
      advanceUntilIdle()
      assertEquals(1, manager.getActiveSubscriptions().size)
      assertEquals(1, app.count("subscribeToFile"))

      // It returns as a new process.
      app.present = true
      manager.onPackageActivity("com.example.app")
      advanceUntilIdle()
      assertEquals(2, app.count("subscribeToFile"))
      app.write(2)
      observer.onChange(false)
      advanceUntilIdle()
      assertEquals(listOf(1L, 2L), nextSequences(2))
    }

  @Test
  fun `a failed re-arm is retried by the next signal even though the token already matches`() =
    runTest(dispatcher) {
      val app = FakeInspectedApp("process-a")
      val observer = wireApp(app)
      app.restart("process-b")
      app.failNextSubscribe = true
      manager.onPackageActivity("com.example.app")
      advanceUntilIdle()
      assertTrue(!app.armed)

      manager.onPackageActivity("com.example.app")
      advanceUntilIdle()
      assertTrue(app.armed)
      assertEquals(3, app.count("subscribeToFile"))

      app.write(1)
      observer.onChange(false)
      advanceUntilIdle()
      assertEquals(listOf(1L), nextSequences(1))
    }

  @Test
  fun `an idle open subscription makes no provider calls however long it stays open`() =
    runTest(dispatcher) {
      val app = FakeInspectedApp("process-a")
      wireApp(app)
      app.calls.clear()

      testScheduler.advanceTimeBy(60 * 60_000L)
      advanceUntilIdle()

      assertEquals(emptyList<String>(), app.calls)
    }

  @Test
  fun `activity signals cost one getChanges per signal and none for unsubscribed packages`() =
    runTest(dispatcher) {
      val app = FakeInspectedApp("process-a")
      wireApp(app)
      app.calls.clear()

      repeat(3) {
        manager.onPackageActivity("com.example.app")
        advanceUntilIdle()
      }
      manager.onPackageActivity("com.other.app")
      advanceUntilIdle()

      assertEquals(List(3) { "getChanges" }, app.calls)

      manager.unsubscribe("com.example.app", "auth")
      app.calls.clear()
      manager.onPackageActivity("com.example.app")
      manager.destroy()
      manager.onPackageActivity("com.example.app")
      advanceUntilIdle()
      assertEquals(emptyList<String>(), app.calls)
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
      manager = StorageSubscriptionManager(app, Dispatchers.IO, this)
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
      manager = StorageSubscriptionManager(app, Dispatchers.IO, owner)
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
        StorageSubscriptionManager(context, dispatcher, this, provider, cleanupTimeoutMs = 100)
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

  private fun changesBundle(fileName: String, sequences: List<Long>): Bundle =
    Bundle().apply {
      putBoolean("success", true)
      putString(
        "result",
        StorageProtocolSerializer.responseToJson(
          StorageResponse.Changes(
            fileName,
            sequences.map { sequence ->
              StorageChangeEvent(fileName, "key-$sequence", "$sequence", "LONG", sequence, sequence)
            },
          )
        ),
      )
    }

  private class RecordingProvider : ContentProvider() {
    val fetchLooper = CompletableDeferred<Looper?>()
    val unsubscribeLooper = CompletableDeferred<Looper?>()

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
      return when (method) {
        "getChanges" -> {
          fetchLooper.complete(Looper.myLooper())
          Bundle().apply {
            putBoolean("success", true)
            putString(
              "result",
              StorageProtocolSerializer.responseToJson(
                StorageResponse.Changes(
                  "auth",
                  listOf(StorageChangeEvent("auth", "key", "value", "STRING", 1L, 1L)),
                )
              ),
            )
          }
        }
        "unsubscribeFromFile" -> {
          unsubscribeLooper.complete(Looper.myLooper())
          Bundle()
        }
        else -> Bundle().apply { putBoolean("success", true) }
      }
    }

    override fun onCreate() = true

    override fun query(
      uri: Uri,
      projection: Array<out String>?,
      selection: String?,
      selectionArgs: Array<out String>?,
      sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0

    override fun update(
      uri: Uri,
      values: ContentValues?,
      selection: String?,
      selectionArgs: Array<out String>?,
    ) = 0
  }

  // ================= Concurrency (#3600) =================

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
