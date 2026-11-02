package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.storage.StorageSubscriptionManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config

/** The stop half of each startup step, on a service that never reached onServiceConnected. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class CtrlProxyServiceLifecycleTest {
  private val controller: ServiceController<CtrlProxy> =
    Robolectric.buildService(CtrlProxy::class.java).create()
  private val service: CtrlProxy = controller.get()
  private var destroyed = false

  @After
  fun tearDown() {
    // onCreate starts the gesture thread; destroying the service quits it.
    if (!destroyed) controller.destroy()
  }

  private fun storageManager(): StorageSubscriptionManager {
    val dispatcher = UnconfinedTestDispatcher()
    return StorageSubscriptionManager(
      service,
      ioDispatcher = dispatcher,
      scope = CoroutineScope(SupervisorJob() + dispatcher),
    )
  }

  private fun StorageSubscriptionManager.isDestroyed() =
    subscribe("com.example.app", "prefs").exceptionOrNull()?.message ==
      "Storage subscription manager is destroyed"

  @Test
  fun `stopping logcat forwarding closes the buffer and forgets it`() {
    val buffer = BoundedLogBuffer(capacity = 4, stats = service.workStats)
    service.logEventBuffer = buffer

    service.stopLogcatForwarding()

    assertTrue("the drain loop ends when the buffer closes", buffer.channel.isClosedForSend)
    assertNull(service.logEventBuffer)
    assertNull(service.logcatReader)
  }

  @Test
  fun `stopping ingestion and storage cancels their collectors`() {
    val navigation = Job().also { service.navigationEventJob = it }
    val storage = Job().also { service.storageChangeJob = it }

    service.stopEventIngestion()
    service.stopStorageSubscription()

    assertTrue(navigation.isCancelled)
    assertTrue(storage.isCancelled)
  }

  @Test
  fun `onDestroy destroys a created storage subscription manager`() {
    val manager = storageManager().also { service.storageSubscriptionManager = it }
    assertEquals(false, manager.isDestroyed())

    controller.destroy()
    destroyed = true

    assertTrue("onDestroy must release the storage manager", manager.isDestroyed())
  }

  @Test
  fun `stopping features that never started is a no-op`() {
    assertNull(service.storageSubscriptionManagerOrNull)
    assertNull(service.webSocketServerOrNull)

    service.stopStorageSubscription()
    service.stopWebSocketServer()
    service.stopLogcatForwarding()
    service.stopEventIngestion()
  }
}
