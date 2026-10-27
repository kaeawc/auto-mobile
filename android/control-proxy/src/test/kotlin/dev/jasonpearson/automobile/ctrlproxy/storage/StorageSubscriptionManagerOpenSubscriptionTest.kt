package dev.jasonpearson.automobile.ctrlproxy.storage

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class StorageSubscriptionManagerOpenSubscriptionTest :
  StorageSubscriptionManagerFixtures() {
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
}
