package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Which prototype lifecycle events end the asset session, and which deliberately do not. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeAssetLifecycleTest {
  private val host = FakePrototypeHost()
  private val timer = FakePrototypeTimer()
  private val events = mutableListOf<PrototypeEvent>()
  private val store = PrototypeAssetStore(FakePrototypeAssetFiles())
  private var blocked = false
  private var session = 1
  private var clearFailure: Exception? = null
  private val lifecycle =
    PrototypeLifecycle(timer, TTL, isBlocked = { blocked }, observerSession = { session })
  private val controller =
    PrototypeController(
      host,
      PrototypeResultSink { _, _, _ -> },
      eventSink = PrototypeEventSink { events += it },
      clock = { timer.now },
      lifecycle = lifecycle,
      clearAssets = {
        clearFailure?.let { throw it }
        store.clear()
      },
    )

  private fun spec(id: String = "panel") =
    PrototypeSpec(
      id,
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root = PrototypeImageNode(asset = PrototypeModeValue.Single("hero")),
    )

  private fun upload() {
    store.put("hero", "image/png", PrototypeAssetBytes.png())
    store.put("alt", "image/jpeg", PrototypeAssetBytes.jpeg())
  }

  private suspend fun showWithAssets() {
    upload()
    controller.show(null, spec())
    assertEquals(2, store.count)
  }

  private fun assertCleared() = assertEquals(0, store.count)

  private fun assertKept() = assertEquals(2, store.count)

  @Test
  fun `agent dismiss by id clears assets`() = runTest {
    showWithAssets()
    controller.dismiss(null, "panel", null)
    assertCleared()
  }

  @Test
  fun `host dismiss control and authored dismiss clear assets`() = runTest {
    showWithAssets()
    host.requests.last().onHostDismiss()
    assertCleared()
    showWithAssets()
    controller.interact(
      checkNotNull(controller.activeRuntime),
      PrototypeInteraction.Tap(listOf(PrototypeDismissAction)),
    )
    assertCleared()
  }

  @Test
  fun `idle expiry clears assets`() = runTest {
    showWithAssets()
    timer.advance(TTL)
    assertCleared()
  }

  @Test
  fun `last client disconnect clears assets whether or not a prototype is showing`() = runTest {
    showWithAssets()
    controller.onClientCountChanged(0)
    assertCleared()
    upload() // uploaded before any show, then the client leaves
    assertFalse(host.isShowing)
    controller.onClientCountChanged(0)
    assertCleared()
  }

  @Test
  fun `a client leaving while others remain keeps assets`() = runTest {
    showWithAssets()
    controller.onClientCountChanged(2)
    controller.onClientCountChanged(1)
    assertKept()
  }

  @Test
  fun `a stale disconnect from an earlier observer session keeps a new sessions assets`() =
    runTest {
      upload()
      session++
      controller.onClientCountChanged(0, observerSession = 1)
      assertKept()
      controller.onClientCountChanged(0, observerSession = session)
      assertCleared()
    }

  @Test
  fun `dismiss all clears uploaded assets even with nothing showing`() = runTest {
    upload()
    controller.dismiss(null, null, true)
    assertCleared()
  }

  @Test
  fun `show and replacement keep assets because the prototype uses them`() = runTest {
    showWithAssets()
    controller.show(null, spec())
    controller.show(null, spec(), reset = true)
    assertKept()
  }

  @Test
  fun `a temporary lock screen hide keeps assets and the restored prototype can still use them`() =
    runTest {
      showWithAssets()
      blocked = true
      controller.onConfigurationChanged()
      assertFalse(host.isShowing)
      assertKept()
      blocked = false
      controller.onConfigurationChanged()
      assertTrue(host.isShowing)
      assertKept()
      assertNotNull(store.lookup("hero"))
    }

  @Test
  fun `a failed window removal is not a dismissal and keeps assets`() = runTest {
    showWithAssets()
    host.accept = false
    controller.dismiss(null, "panel", null)
    assertKept()
    assertTrue(events.isEmpty())
  }

  @Test
  fun `service unbind clears assets with or without a prototype`() = runTest {
    showWithAssets()
    controller.dismissForUnbind()
    assertCleared()
    upload()
    controller.dismissForUnbind()
    assertCleared()
  }

  @Test
  fun `service teardown clears assets and stays safe to repeat`() = runTest {
    showWithAssets()
    controller.destroy()
    assertCleared()
    controller.destroy()
    assertCleared()
  }

  @Test
  fun `a prototype that cannot be re-shown is abandoned and its assets cleared`() = runTest {
    showWithAssets()
    host.isShowing = false
    host.accept = false
    controller.onConfigurationChanged()
    assertEquals(PrototypeEventKind.DISMISSED, events.last().kind)
    assertCleared()
  }

  @Test
  fun `a cleanup failure never blocks the dismissal or its event`() = runTest {
    showWithAssets()
    clearFailure = IllegalStateException("disk gone")
    controller.dismiss(null, "panel", null)
    assertEquals(PrototypeEventKind.DISMISSED, events.single().kind)
    assertFalse(host.isShowing)
    controller.destroy()
    assertKept() // the injected failure stopped the clear; nothing else was affected
  }

  private companion object {
    const val TTL = 1_000L
  }
}
