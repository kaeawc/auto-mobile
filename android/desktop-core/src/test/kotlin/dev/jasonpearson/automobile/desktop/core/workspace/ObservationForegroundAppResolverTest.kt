package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamKey
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.FakeTelemetryMultiplexer
import dev.jasonpearson.automobile.desktop.core.daemon.HierarchyStreamUpdate
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationHubConfig
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationReconnectPolicy
import dev.jasonpearson.automobile.desktop.core.daemon.SharedDaemonStreamHub
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Locale control's foreground-app lookup (#17027). */
@OptIn(ExperimentalCoroutinesApi::class)
class ObservationForegroundAppResolverTest {
  private val phone = DeviceStreamKey("emulator-5554", "uuid-a")

  private fun tree(timestamp: Long, packageName: String?) =
    HierarchyStreamUpdate(phone.deviceId, timestamp, data = null, packageName = packageName)

  private class Hub(val hub: SharedDaemonStreamHub, val streams: List<FakeObservationStream>)

  private fun TestScope.hub(): Hub {
    val streams = mutableListOf<FakeObservationStream>()
    val hub =
      SharedDaemonStreamHub(
        telemetry = FakeTelemetryMultiplexer(),
        scope =
          CoroutineScope(
            backgroundScope.coroutineContext + UnconfinedTestDispatcher(testScheduler),
          ),
        observation =
          ObservationHubConfig(
            streamFactory = { FakeObservationStream().also { streams.add(it) } },
            reconnect = ObservationReconnectPolicy({ awaitCancellation() }, { true }),
          ),
      )
    return Hub(hub, streams)
  }

  @Test
  fun `a pane's device is looked up on the stream the pane leases`() =
    runTest(UnconfinedTestDispatcher()) {
      val h = hub()
      h.hub.observationStream(phone).connect()
      val shared = h.streams.single()
      shared.emitHierarchy(tree(100, "com.stale"))
      var opened = 0
      val resolver =
        ObservationForegroundAppResolver(
          observationStreamFactory = { FakeObservationStream().also { opened++ } },
          hub = { h.hub },
        )

      val app = async { resolver.resolve(phone.deviceId) }
      assertEquals(1, shared.observationRequestCount)
      assertEquals(mapOf(phone to 2), h.hub.observationSubscriptions.value)
      assertFalse(app.isCompleted)

      shared.emitHierarchy(tree(200, "com.fresh"))
      assertEquals("com.fresh", app.await())
      assertEquals(0, opened)
      assertEquals(1, h.streams.size)
      assertEquals(mapOf(phone to 1), h.hub.observationSubscriptions.value)
      h.hub.close()
    }

  @Test
  fun `a device no pane leases gets its own short-lived stream`() =
    runTest(UnconfinedTestDispatcher()) {
      val h = hub()
      val own = FakeObservationStream()
      val resolver =
        ObservationForegroundAppResolver(observationStreamFactory = { own }, hub = { h.hub })

      val app = async { resolver.resolve(phone.deviceId) }
      assertEquals(phone.deviceId, own.lastConnectedDeviceId)
      own.emitHierarchy(tree(1, "com.example"))

      assertEquals("com.example", app.await())
      assertTrue(h.streams.isEmpty())
      assertEquals(1, own.disconnectCallCount)
      h.hub.close()
    }
}
