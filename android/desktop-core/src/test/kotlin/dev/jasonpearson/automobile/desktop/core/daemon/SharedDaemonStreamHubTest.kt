package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SharedDaemonStreamHubTest {
  private val phoneA = DeviceStreamKey("emulator-5554", "uuid-a")
  private val phoneB = DeviceStreamKey("emulator-5556", "uuid-b")

  private class Harness(scope: CoroutineScope) {
    val clients = mutableListOf<FakeTelemetryPushClient>()
    val hub = SharedDaemonStreamHub({ FakeTelemetryPushClient().also { clients.add(it) } }, scope)
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
  fun `forty observed devices share one all-devices telemetry connection`() = runTest {
    val h = harness()
    val leases =
      (0 until 40).map { h.hub.subscribeTelemetry(DeviceStreamKey("emulator-$it", "uuid-$it")) {} }

    assertEquals(1, h.clients.size)
    assertNull(h.clients.single().getLastDeviceId())
    assertNull(h.clients.single().getLastDeviceSessionUuid())
    assertEquals(1, h.clients.single().getConnectCallCount())
    leases.forEach { it.close() }
  }

  @Test
  fun `each pane's telemetry view carries only its own device`() = runTest {
    val h = harness()
    val paneA = h.hub.telemetryClient(phoneA).also { it.connect() }
    val paneB = h.hub.telemetryClient(phoneB).also { it.connect() }
    val shared = h.clients.single()

    shared.emitEvent(log("a1", "emulator-5554", "uuid-a"))
    shared.emitEvent(log("b1", "emulator-5556", "uuid-b"))
    shared.emitEvent(log("unattributed", null, null))
    shared.emitEvent(log("a2", "emulator-5554", "uuid-a"))

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

    h.clients.single().emitEvent(log("rebooted", "emulator-5554", "uuid-a2"))
    h.clients.single().emitEvent(log("unstamped", "emulator-5554", null))

    assertEquals(listOf("unstamped"), messages(received))
    lease.close()
  }

  @Test
  fun `subscriptions are ref-counted and the connection closes with the last lease`() = runTest {
    val h = harness()
    val first = h.hub.subscribeTelemetry(phoneA) {}
    val second = h.hub.subscribeTelemetry(phoneA) {}
    val other = h.hub.subscribeTelemetry(phoneB) {}
    assertEquals(mapOf(phoneA to 2, phoneB to 1), h.hub.subscriptions.value)

    first.close()
    first.close()
    assertEquals(mapOf(phoneA to 1, phoneB to 1), h.hub.subscriptions.value)
    second.close()
    assertEquals(mapOf(phoneB to 1), h.hub.subscriptions.value)
    assertEquals(0, h.clients.single().getDisconnectCallCount())

    other.close()
    assertEquals(emptyMap<DeviceStreamKey, Int>(), h.hub.subscriptions.value)
    assertEquals(1, h.clients.single().getDisconnectCallCount())

    h.hub.subscribeTelemetry(phoneA) {}.close()
    assertEquals(2, h.clients.size)
  }

  @Test
  fun `a pane mounted on an open connection receives its device's recent events`() = runTest {
    val h = harness()
    val early = h.hub.subscribeTelemetry(phoneB) {}
    h.clients.single().emitEvent(log("before", "emulator-5554", "uuid-a"))
    h.clients.single().emitEvent(log("other", "emulator-5556", "uuid-b"))

    val received = mutableListOf<TelemetryDisplayEvent>()
    val late = h.hub.subscribeTelemetry(phoneA) { received.add(it) }
    h.clients.single().emitEvent(log("after", "emulator-5554", "uuid-a"))

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

    h.clients.single().emitEvent(log("a", "emulator-5554", "uuid-a"))

    assertTrue(job.isCompleted)
    assertEquals(listOf("a"), messages(collected))
    assertEquals(emptyMap<DeviceStreamKey, Int>(), h.hub.subscriptions.value)
  }

  @Test
  fun `view reconnect retries the failed shared connection without a second lease`() = runTest {
    val h = harness()
    val pane = h.hub.telemetryClient(phoneA)
    pane.connect()
    val shared = h.clients.single()
    shared.setConnectionState(ConnectionState.Error("down"))
    assertEquals(ConnectionState.Error("down"), h.hub.telemetryConnectionState.value)
    assertFalse(pane.isConnected())

    pane.connect()

    assertEquals(2, shared.getConnectCallCount())
    assertEquals(mapOf(phoneA to 1), h.hub.subscriptions.value)
    assertTrue(pane.isConnected())
    pane.dispose()
    assertEquals(ConnectionState.Disconnected(null), h.hub.telemetryConnectionState.value)
  }
}
