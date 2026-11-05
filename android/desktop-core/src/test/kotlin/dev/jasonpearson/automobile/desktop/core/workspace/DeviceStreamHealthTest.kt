package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamKey
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.FakeTelemetryPushClient
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationHubConfig
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationReconnectPolicy
import dev.jasonpearson.automobile.desktop.core.daemon.SharedDaemonStreamHub
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DeviceStreamHealthTest {
  private val a = DeviceColumn("emulator-5554", "A", Platform.Android, deviceSessionUuid = "uuid-a")
  private val b = DeviceColumn("emulator-5556", "B", Platform.Android, deviceSessionUuid = "uuid-b")

  private fun DeviceColumn.key() = DeviceStreamKey(deviceId, deviceSessionUuid)

  private class Harness(scope: CoroutineScope) {
    val telemetry = mutableListOf<FakeTelemetryPushClient>()
    val observations = mutableListOf<FakeObservationStream>()
    val hub =
      SharedDaemonStreamHub(
        telemetryClientFactory = { FakeTelemetryPushClient().also { telemetry += it } },
        scope = scope,
        observation =
          ObservationHubConfig(
            streamFactory = { FakeObservationStream().also { observations += it } },
            reconnect =
              ObservationReconnectPolicy(
                backoffDelay = { awaitCancellation() },
                socketAvailable = { true },
              ),
          ),
      )
  }

  private fun TestScope.harness() =
    Harness(
      CoroutineScope(backgroundScope.coroutineContext + UnconfinedTestDispatcher(testScheduler)),
    )

  private fun TestScope.collect(
    h: Harness,
    columns: List<DeviceColumn>,
  ): MutableStateFlow<List<ConnectionState>?> {
    val latest = MutableStateFlow<List<ConnectionState>?>(null)
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
      h.hub.deviceStreamHealth(columns).collect { latest.value = it }
    }
    return latest
  }

  @Test
  fun `devices with no open stream are not reported`() = runTest {
    val h = harness()
    val latest = collect(h, listOf(a, b))
    assertEquals(emptyList<ConnectionState>(), latest.value)
  }

  @Test
  fun `a leased device reports its stream state and drops out on release`() = runTest {
    val h = harness()
    val latest = collect(h, listOf(a, b))
    val lease = h.hub.subscribeTelemetry(a.key()) {}
    h.telemetry.single().setConnectionState(ConnectionState.Connected())
    assertEquals(listOf(ConnectionState.Connected()), latest.value)

    h.telemetry.single().setConnectionState(ConnectionState.Error("socket closed"))
    assertEquals(listOf(ConnectionState.Error("socket closed")), latest.value)

    lease.close()
    assertEquals(emptyList<ConnectionState>(), latest.value)
  }

  @Test
  fun `one entry per device holds the worst of its streams`() = runTest {
    val h = harness()
    val latest = collect(h, listOf(a, b))
    h.hub.subscribeTelemetry(a.key()) {}
    h.hub.observationStream(a.key()).connect()
    h.hub.subscribeTelemetry(b.key()) {}
    val (telemetryA, telemetryB) = h.telemetry
    telemetryA.setConnectionState(ConnectionState.Reconnecting(1, 1_000))
    telemetryB.setConnectionState(ConnectionState.Connected())

    // Device A's observation stream is connected; its telemetry stream is not.
    assertEquals(ConnectionState.Connected(), h.hub.observationConnectionState(a.key()).value)
    assertEquals(
      listOf(ConnectionState.Reconnecting(1, 1_000), ConnectionState.Connected()),
      latest.value,
    )

    h.observations.single().emitConnectionState(ConnectionState.Error("socket closed"))
    assertEquals(
      listOf(ConnectionState.Error("socket closed"), ConnectionState.Connected()),
      latest.value,
    )
  }

  @Test
  fun `a stream for an epoch the workspace no longer shows is ignored`() = runTest {
    val h = harness()
    val latest = collect(h, listOf(a))
    h.hub.subscribeTelemetry(DeviceStreamKey(a.deviceId, "uuid-retired")) {}
    h.telemetry.single().setConnectionState(ConnectionState.Error("gone"))
    assertEquals(emptyList<ConnectionState>(), latest.value)
  }

  @Test
  fun `worstOf ranks offline over reconnecting over connected`() {
    assertEquals(
      ConnectionState.Error("x"),
      worstOf(
        listOf(ConnectionState.Connected(), ConnectionState.Connecting, ConnectionState.Error("x")),
      ),
    )
    assertEquals(
      ConnectionState.Connecting,
      worstOf(listOf(ConnectionState.Connected(), ConnectionState.Connecting)),
    )
  }
}
