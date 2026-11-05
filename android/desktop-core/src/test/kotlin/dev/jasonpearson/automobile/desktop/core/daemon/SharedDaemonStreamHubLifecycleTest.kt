package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Lifecycle-only leases (#17061): they share a device's stream but never ask it for frames. */
@OptIn(ExperimentalCoroutinesApi::class)
class SharedDaemonStreamHubLifecycleTest {
  private val phone = DeviceStreamKey("emulator-5554", "uuid-a")
  private val idle =
    LIFECYCLE_ONLY_CADENCE.screenshotIntervalMs to LIFECYCLE_ONLY_CADENCE.hierarchyIntervalMs

  private class Harness(scope: CoroutineScope) {
    val streams = mutableListOf<FakeObservationStream>()
    val hub =
      SharedDaemonStreamHub(
        telemetryClientFactory = { FakeTelemetryPushClient() },
        scope = scope,
        observation =
          ObservationHubConfig(
            streamFactory = { FakeObservationStream().also { streams.add(it) } },
            reconnect = ObservationReconnectPolicy({ awaitCancellation() }, { true }),
          ),
      )
  }

  private fun TestScope.harness() =
    Harness(
      CoroutineScope(backgroundScope.coroutineContext + UnconfinedTestDispatcher(testScheduler)),
    )

  @Test
  fun `a stream held only by a lifecycle lease asks for no frames`() = runTest {
    val h = harness()
    val lifecycle = h.hub.observationStream(phone, lifecycleOnly = true).also { it.connect() }

    val shared = h.streams.single()
    assertEquals(1, shared.connectCallCount)
    assertEquals(listOf(idle), shared.cadenceCalls)
    assertEquals(mapOf(phone to 1), h.hub.observationSubscriptions.value)

    // A lifecycle lease's own cadence request is ignored.
    lifecycle.setCadence(screenshotIntervalMs = 250L, hierarchyIntervalMs = 250L)
    assertEquals(listOf(idle), shared.cadenceCalls)
  }

  @Test
  fun `a facet joining a lifecycle lease restores the default cadence, and leaving idles it`() =
    runTest {
      val h = harness()
      h.hub.observationStream(phone, lifecycleOnly = true).connect()
      val shared = h.streams.single()

      val facet = h.hub.observationStream(phone).also { it.connect() }
      assertEquals(1, h.streams.size)
      assertEquals(listOf(idle, null to null), shared.cadenceCalls)

      facet.setCadence(screenshotIntervalMs = 5_000L, hierarchyIntervalMs = null)
      assertEquals(5_000L to null, shared.cadenceCalls.last())

      facet.dispose()
      assertEquals(idle, shared.cadenceCalls.last())
      assertEquals(0, shared.disconnectCallCount)
      assertEquals(mapOf(phone to 1), h.hub.observationSubscriptions.value)
    }

  @Test
  fun `a lifecycle lease joining a facet leaves the facet's cadence alone`() = runTest {
    val h = harness()
    val facet = h.hub.observationStream(phone).also { it.connect() }
    facet.setCadence(screenshotIntervalMs = 1_000L, hierarchyIntervalMs = 2_000L)
    val shared = h.streams.single()

    val lifecycle = h.hub.observationStream(phone, lifecycleOnly = true).also { it.connect() }
    assertEquals(listOf(1_000L to 2_000L), shared.cadenceCalls)

    lifecycle.dispose()
    assertEquals(listOf(1_000L to 2_000L), shared.cadenceCalls)
    assertEquals(0, shared.disconnectCallCount)
  }

  @Test
  fun `the lifecycle lease hears the shared stream's device events`() = runTest {
    val h = harness()
    val lifecycle = h.hub.observationStream(phone, lifecycleOnly = true).also { it.connect() }
    val ended = DeviceStreamEvent.DeviceSessionEnded(phone.deviceId, "uuid-a", 1L)

    assertTrue(h.streams.single().emitDeviceEvent(ended))

    assertEquals(listOf(ended), lifecycle.deviceEvents.replayCache)
    lifecycle.dispose()
    assertEquals(1, h.streams.single().disconnectCallCount)
    assertTrue(h.hub.observationSubscriptions.value.isEmpty())
  }
}
