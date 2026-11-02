package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.coroutines.Job
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The stop half of each startup step, on a service that never reached onServiceConnected. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class CtrlProxyServiceLifecycleTest {
  private val service: CtrlProxy = Robolectric.buildService(CtrlProxy::class.java).create().get()

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
  fun `stopping features that never started is a no-op`() {
    assertNull(service.storageSubscriptionManagerOrNull)
    assertNull(service.webSocketServerOrNull)

    service.stopStorageSubscription()
    service.stopWebSocketServer()
    service.stopLogcatForwarding()
    service.stopEventIngestion()
  }
}
