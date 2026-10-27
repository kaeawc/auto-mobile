package dev.jasonpearson.automobile.ctrlproxy.storage

import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import java.util.concurrent.TimeUnit.SECONDS
import kotlinx.coroutines.flow.first
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class StorageSubscriptionManagerAcquisitionTest : StorageSubscriptionManagerFixtures() {
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
  fun `subscribe to a stopped app that stays disabled says the request started it`() {
    givenInstalledPackage("com.example.app", stopped = true)
    givenSubscribeReplies(disabledReply())

    val result = manager.subscribe("com.example.app", "auth")

    val error = result.exceptionOrNull()
    assertTrue(error is StorageError.AppStartedByRequest)
    assertEquals(
      "app com.example.app was not running; this request started it but its storage inspection " +
        "did not become available. Launch the app normally and subscribe again",
      error?.message,
    )
    assertTrue(manager.getActiveSubscriptions().isEmpty())
    verify(exactly = 2) { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) }
  }

  @Test
  fun `subscribe to a stopped app whose inspection comes up on the retry succeeds`() {
    givenInstalledPackage("com.example.app", stopped = true)
    givenSubscribeReplies(disabledReply(), successReply())

    assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
    assertEquals(1, pauses.size)
    assertEquals(1, manager.getActiveSubscriptions().size)
  }

  @Test
  fun `a dead process with the stopped flag clear retries and subscribes`() {
    // Swipe-away, low-memory kill, crash or reboot: not FLAG_STOPPED, yet the provider call still
    // cold-starts the process and can beat the app's own inspection setup.
    givenInstalledPackage("com.example.app", stopped = false)
    givenSubscribeReplies(disabledReply(), successReply())

    val result = manager.subscribe("com.example.app", "auth")

    assertTrue(result.isSuccess)
    assertEquals(1, pauses.size)
    verify(exactly = 2) { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) }
  }

  @Test
  fun `a genuinely disabled running app is retried exactly once then keeps the SDK message`() {
    givenInstalledPackage("com.example.app", stopped = false)
    givenSubscribeReplies(disabledReply())

    val error = manager.subscribe("com.example.app", "auth").exceptionOrNull()

    assertTrue(error is StorageError.SdkError)
    assertEquals("SharedPreferences inspection is disabled", error?.message)
    assertEquals(1, pauses.size)
    verify(exactly = 2) { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) }
  }

  @Test
  fun `a reply other than disabled is not retried`() {
    givenInstalledPackage("com.example.app", stopped = true)
    givenSubscribeReplies(
      Bundle().apply {
        putBoolean("success", false)
        putString("errorType", "FileNotFound")
        putString("error", "Preferences file not found: auth")
      },
    )

    manager.subscribe("com.example.app", "auth")

    assertTrue(pauses.isEmpty())
    verify(exactly = 1) { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) }
  }

  @Test
  fun `subscribe to a stopped app that answers is still accepted`() {
    givenInstalledPackage("com.example.app", stopped = true)
    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
      Bundle().apply { putBoolean("success", true) }

    assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
  }

  @Test
  fun `a stopped app failing for another reason keeps its own error`() {
    givenInstalledPackage("com.example.app", stopped = true)
    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
      Bundle().apply {
        putBoolean("success", false)
        putString("errorType", "FileNotFound")
        putString("error", "Preferences file not found: auth")
      }

    val error = manager.subscribe("com.example.app", "auth").exceptionOrNull()

    assertTrue(error is StorageError.SdkError)
    assertEquals("Preferences file not found: auth", error?.message)
  }

  @Test
  fun `a package the runner cannot look up keeps the SDK message`() {
    val packageManager = mockk<PackageManager>(relaxed = true)
    // Exercise NameNotFoundException from the production lookup's legacy overload.
    @Suppress("DEPRECATION")
    every { packageManager.getApplicationInfo(any<String>(), any<Int>()) } throws
      PackageManager.NameNotFoundException("com.example.app")
    every { context.packageManager } returns packageManager
    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } returns
      disabledReply()

    val error = manager.subscribe("com.example.app", "auth").exceptionOrNull()

    assertTrue(error is StorageError.SdkError)
    assertEquals("SharedPreferences inspection is disabled", error?.message)
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
          // Generous ceiling only so a broken test cannot hang; a loaded CI JVM must not trip it.
          assertTrue(releaseFirstRegistration.await(LATCH_CEILING_SECONDS, SECONDS))
          throw SecurityException("first registration denied")
        }
      }

    val firstResult = java.util.concurrent.atomic.AtomicReference<Result<StorageSubscription>>()
    val secondResult = java.util.concurrent.atomic.AtomicReference<Result<StorageSubscription>>()
    val first = Thread { firstResult.set(manager.subscribe("com.example.app", "auth")) }
    first.start()
    assertTrue(firstRegistrationEntered.await(LATCH_CEILING_SECONDS, SECONDS))
    val second = Thread { secondResult.set(manager.subscribe("com.example.app", "auth")) }
    second.start()
    // Release only once the second caller is actually contending for the first caller's
    // per-subscription lock; otherwise the test may never exercise the concurrent path.
    val deadlineNanos = System.nanoTime() + SECONDS.toNanos(LATCH_CEILING_SECONDS)
    while (second.state != Thread.State.BLOCKED && System.nanoTime() < deadlineNanos) {
      Thread.yield()
    }
    assertEquals(Thread.State.BLOCKED, second.state)
    releaseFirstRegistration.countDown()
    first.join(JOIN_CEILING_MS)
    second.join(JOIN_CEILING_MS)

    assertTrue(firstResult.get()?.isFailure == true)
    assertTrue(secondResult.get()?.isSuccess == true)
    assertEquals(
      listOf("com.example.app:auth"),
      manager.getActiveSubscriptions().map { it.subscriptionId },
    )
  }
}
