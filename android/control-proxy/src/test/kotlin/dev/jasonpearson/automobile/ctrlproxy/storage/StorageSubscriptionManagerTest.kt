package dev.jasonpearson.automobile.ctrlproxy.storage

import android.content.ContentResolver
import android.content.Context
import android.database.ContentObserver
import android.net.Uri
import android.os.Bundle
import dev.jasonpearson.automobile.protocol.StorageChangeEvent
import dev.jasonpearson.automobile.protocol.StorageProtocolSerializer
import dev.jasonpearson.automobile.protocol.StorageResponse
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class StorageSubscriptionManagerTest {

  private lateinit var context: Context
  private lateinit var contentResolver: ContentResolver
  private lateinit var manager: StorageSubscriptionManager

  @Before
  fun setUp() {
    contentResolver = mockk(relaxed = true)
    context = mockk(relaxed = true)
    every { context.contentResolver } returns contentResolver
    manager = StorageSubscriptionManager(context)
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
  fun `subscribe returns same subscription when already subscribed`() {
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

    // Should only call SDK once since second subscribe reuses existing
    verify(exactly = 1) { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) }
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
  fun `storage event bursts retain a bounded latest sequence for gap reconciliation`() =
    runBlocking {
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

      val received = withTimeout(1_000) { manager.changeEvents.take(64).toList() }
      assertEquals((37L..100L).toList(), received.map { it.sequenceNumber })
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
  fun `unsubscribe returns false when not subscribed`() {
    val result = manager.unsubscribe("com.example.app", "nonexistent")

    assertFalse(result)
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
