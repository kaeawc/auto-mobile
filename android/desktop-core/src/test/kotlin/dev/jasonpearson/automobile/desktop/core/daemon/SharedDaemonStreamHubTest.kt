package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SharedDaemonStreamHubTest {
  private val phoneA = DeviceStreamKey("emulator-5554", "uuid-a")
  private val phoneB = DeviceStreamKey("emulator-5556", "uuid-b")

  private class Harness(scope: CoroutineScope) {
    val telemetry = FakeTelemetryMultiplexer()
    val hub = SharedDaemonStreamHub(telemetry, scope)

    /** [key]'s live device-scoped subscription. */
    fun subscriptionFor(key: DeviceStreamKey) = telemetry.subscriptionFor(key)
  }

  private fun TestScope.harness() =
    Harness(
      CoroutineScope(backgroundScope.coroutineContext + UnconfinedTestDispatcher(testScheduler)),
    )

  private fun log(message: String, deviceId: String?, deviceSessionUuid: String?) =
    TelemetryDisplayEvent.Log(
      timestamp = 1L,
      level = 4,
      tag = "t",
      message = message,
      deviceId = deviceId,
      deviceSessionUuid = deviceSessionUuid,
    )

  private fun messages(events: List<TelemetryDisplayEvent>) = events.map {
    (it as TelemetryDisplayEvent.Log).message
  }

  @Test
  fun `facets on the same device share one device-scoped subscription`() = runTest {
    val h = harness()
    val devices = (0 until 40).map { DeviceStreamKey("emulator-$it", "uuid-$it") }
    // Two facets (e.g. Logs and a second telemetry consumer) per device.
    val leases = devices.flatMap { key ->
      listOf(h.hub.subscribeTelemetry(key) {}, h.hub.subscribeTelemetry(key) {})
    }

    assertEquals(devices, h.telemetry.subscriptions.map { it.key })
    leases.forEach { it.close() }
  }

  @Test
  fun `each pane's telemetry view carries only its own device`() = runTest {
    val h = harness()
    val paneA = h.hub.telemetryClient(phoneA).also { it.connect() }
    val paneB = h.hub.telemetryClient(phoneB).also { it.connect() }

    h.subscriptionFor(phoneA).emit(log("a1", "emulator-5554", "uuid-a"))
    h.subscriptionFor(phoneB).emit(log("b1", "emulator-5556", "uuid-b"))
    h.subscriptionFor(phoneA).emit(log("unattributed", null, null))
    h.subscriptionFor(phoneA).emit(log("a2", "emulator-5554", "uuid-a"))

    assertEquals(listOf("a1", "a2"), messages(paneA.telemetryEvents.replayCache))
    assertEquals(listOf("b1"), messages(paneB.telemetryEvents.replayCache))
    paneA.dispose()
    paneB.dispose()
  }

  @Test
  fun `a reused serial from a new epoch is not routed to the old epoch`() = runTest {
    val h = harness()
    val received = mutableListOf<TelemetryDisplayEvent>()
    val lease = h.hub.subscribeTelemetry(phoneA) { received.add(it) }

    h.subscriptionFor(phoneA).emit(log("rebooted", "emulator-5554", "uuid-a2"))
    h.subscriptionFor(phoneA).emit(log("unstamped", "emulator-5554", null))

    assertEquals(listOf("unstamped"), messages(received))
    lease.close()
  }

  @Test
  fun `subscriptions are ref-counted and a device's subscription closes with its last lease`() =
    runTest {
      val h = harness()
      val first = h.hub.subscribeTelemetry(phoneA) {}
      val second = h.hub.subscribeTelemetry(phoneA) {}
      val other = h.hub.subscribeTelemetry(phoneB) {}
      assertEquals(mapOf(phoneA to 2, phoneB to 1), h.hub.subscriptions.value)

      val (subscriptionA, subscriptionB) = h.telemetry.subscriptions

      first.close()
      first.close()
      assertEquals(mapOf(phoneA to 1, phoneB to 1), h.hub.subscriptions.value)
      assertFalse(subscriptionA.closed)

      second.close()
      assertEquals(mapOf(phoneB to 1), h.hub.subscriptions.value)
      assertTrue(subscriptionA.closed)
      assertFalse(subscriptionB.closed)

      other.close()
      assertEquals(emptyMap<DeviceStreamKey, Int>(), h.hub.subscriptions.value)
      assertTrue(subscriptionB.closed)

      // A later lease subscribes afresh.
      h.hub.subscribeTelemetry(phoneA) {}.close()
      assertEquals(listOf(phoneA, phoneB, phoneA), h.telemetry.subscriptions.map { it.key })
    }

  @Test
  fun `a facet mounted on a live subscription receives its device's recent events`() = runTest {
    val h = harness()
    val early = h.hub.subscribeTelemetry(phoneA) {}
    h.subscriptionFor(phoneA).emit(log("before", "emulator-5554", "uuid-a"))

    val received = mutableListOf<TelemetryDisplayEvent>()
    val late = h.hub.subscribeTelemetry(phoneA) { received.add(it) }
    h.subscriptionFor(phoneA).emit(log("after", "emulator-5554", "uuid-a"))

    assertEquals(listOf("before", "after"), messages(received))
    early.close()
    late.close()
  }

  @Test
  fun `telemetry flow holds a lease only while collected`() = runTest {
    val h = harness()
    val collected = mutableListOf<TelemetryDisplayEvent>()
    val job =
      backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
        h.hub.telemetry(phoneA).take(1).toList(collected)
      }
    assertEquals(mapOf(phoneA to 1), h.hub.subscriptions.value)

    h.subscriptionFor(phoneA).emit(log("a", "emulator-5554", "uuid-a"))

    assertTrue(job.isCompleted)
    assertEquals(listOf("a"), messages(collected))
    assertEquals(emptyMap<DeviceStreamKey, Int>(), h.hub.subscriptions.value)
  }

  @Test
  fun `view reconnect retries its failed device subscription without a second lease`() = runTest {
    val h = harness()
    val pane = h.hub.telemetryClient(phoneA)
    pane.connect()
    val shared = h.subscriptionFor(phoneA)
    val retriesOnConnect = shared.retryCount
    shared.setState(ConnectionState.Error("down"))
    assertEquals(ConnectionState.Error("down"), h.hub.telemetryConnectionState(phoneA).value)
    assertFalse(pane.isConnected())

    pane.connect()

    assertEquals(retriesOnConnect + 1, shared.retryCount)
    assertEquals(1, h.telemetry.subscriptions.size)
    assertEquals(mapOf(phoneA to 1), h.hub.subscriptions.value)
    assertTrue(pane.isConnected())
    pane.dispose()
    assertEquals(ConnectionState.Disconnected(null), h.hub.telemetryConnectionState(phoneA).value)
  }

  @Test
  fun `closing the hub releases every subscription and the multiplexer`() = runTest {
    val h = harness()
    h.hub.subscribeTelemetry(phoneA) {}
    h.hub.subscribeTelemetry(phoneB) {}

    h.hub.close()

    assertTrue(h.telemetry.subscriptions.all { it.closed })
    assertTrue(h.telemetry.closed)
  }

  /** Refuses its first subscribe, as a closed multiplexer would, then accepts. */
  private class RefusingOnceMultiplexer : TelemetryMultiplexer {
    var subscribes = 0

    override fun subscribe(
      key: DeviceStreamKey,
      sink: (TelemetryDisplayEvent) -> Unit,
    ): TelemetrySubscription {
      check(++subscribes > 1) { "Telemetry multiplexer is closed" }
      return object : TelemetrySubscription {
        override val state = MutableStateFlow<ConnectionState>(ConnectionState.Connecting)

        override fun retry() = Unit

        override fun close() = Unit
      }
    }

    override fun close() = Unit
  }

  @Test
  fun `a refused subscribe leaves no half-built device behind`() = runTest {
    val telemetry = RefusingOnceMultiplexer()
    val hub =
      SharedDaemonStreamHub(
        telemetry,
        CoroutineScope(backgroundScope.coroutineContext + UnconfinedTestDispatcher(testScheduler)),
      )

    assertThrows(IllegalStateException::class.java) { hub.subscribeTelemetry(phoneA) {} }
    hub.retry(phoneA)
    val lease = hub.subscribeTelemetry(phoneA) {}

    // The next lease subscribes afresh instead of joining the device that never subscribed.
    assertEquals(2, telemetry.subscribes)
    lease.close()
    hub.close()
  }
}
