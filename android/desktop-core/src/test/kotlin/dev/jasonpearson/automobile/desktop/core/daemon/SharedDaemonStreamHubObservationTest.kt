package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SharedDaemonStreamHubObservationTest {
  private val phoneA = DeviceStreamKey("emulator-5554", "uuid-a")
  private val phoneB = DeviceStreamKey("emulator-5556", "uuid-b")

  private class Harness(scope: CoroutineScope) {
    val streams = mutableListOf<FakeObservationStream>()
    // Each reconnect backoff waits for the test to release one gate.
    val backoffGates = Channel<Unit>(Channel.UNLIMITED)
    val backoffAttempts = mutableListOf<Int>()
    var socketAvailable = true
    val hub =
      SharedDaemonStreamHub(
        telemetry = FakeTelemetryMultiplexer(),
        scope = scope,
        observation =
          ObservationHubConfig(
            streamFactory = { FakeObservationStream().also { streams.add(it) } },
            reconnect =
              ObservationReconnectPolicy(
                backoffDelay = { attempt ->
                  backoffAttempts.add(attempt)
                  backoffGates.receive()
                },
                socketAvailable = { socketAvailable },
              ),
          ),
      )

    fun streamFor(key: DeviceStreamKey) = streams.single {
      it.lastConnectedDeviceSessionUuid == key.deviceSessionUuid
    }
  }

  private fun TestScope.harness() =
    Harness(
      CoroutineScope(backgroundScope.coroutineContext + UnconfinedTestDispatcher(testScheduler)),
    )

  @Test
  fun `layout, performance and navigation on one device share one observation connection`() =
    runTest {
      val h = harness()
      val facets = List(3) { h.hub.observationStream(phoneA).also { it.connect() } }
      h.hub.observationStream(phoneB).connect()

      assertEquals(2, h.streams.size)
      val shared = h.streamFor(phoneA)
      assertEquals(1, shared.connectCallCount)
      assertEquals("emulator-5554", shared.lastConnectedDeviceId)
      assertEquals(mapOf(phoneA to 3, phoneB to 1), h.hub.observationSubscriptions.value)
      assertTrue(facets.all { it.isConnected() })
    }

  @Test
  fun `every facet on the device sees the shared stream's updates`() = runTest {
    val h = harness()
    val layout = h.hub.observationStream(phoneA).also { it.connect() }
    val performance = h.hub.observationStream(phoneA).also { it.connect() }
    val update = DeviceStreamEvent.DeviceSessionSuperseded("emulator-5554", "uuid-a", "uuid-c", 1L)

    assertTrue(h.streamFor(phoneA).emitDeviceEvent(update))

    assertEquals(listOf(update), layout.deviceEvents.replayCache)
    assertEquals(listOf(update), performance.deviceEvents.replayCache)
  }

  @Test
  fun `unmounting releases the lease and the last release closes the stream`() = runTest {
    val h = harness()
    val layout = h.hub.observationStream(phoneA).also { it.connect() }
    val navigation = h.hub.observationStream(phoneA).also { it.connect() }
    val shared = h.streamFor(phoneA)

    layout.dispose()
    layout.dispose()
    assertEquals(mapOf(phoneA to 1), h.hub.observationSubscriptions.value)
    assertEquals(0, shared.disconnectCallCount)

    navigation.dispose()
    assertEquals(emptyMap<DeviceStreamKey, Int>(), h.hub.observationSubscriptions.value)
    assertEquals(1, shared.disconnectCallCount)
    assertEquals(
      ConnectionState.Disconnected(null),
      h.hub.observationConnectionState(phoneA).value,
    )

    // A later facet opens a fresh connection.
    h.hub.observationStream(phoneA).connect()
    assertEquals(2, h.streams.size)
  }

  @Test
  fun `per-device observation health follows that device's shared connection`() = runTest {
    val h = harness()
    h.hub.observationStream(phoneA).connect()
    h.hub.observationStream(phoneB).connect()

    h.streamFor(phoneB).emitConnectionState(ConnectionState.Error("socket closed"))

    assertTrue(h.hub.observationConnectionState(phoneA).value is ConnectionState.Connected)
    assertEquals(
      ConnectionState.Error("socket closed"),
      h.hub.observationConnectionState(phoneB).value,
    )
  }

  @Test
  fun `the hub reconnects a dropped stream with backoff, skipping while the socket is gone`() =
    runTest {
      val h = harness()
      val facets = List(3) { h.hub.observationStream(phoneA).also { it.connect() } }
      val shared = h.streamFor(phoneA)

      h.socketAvailable = false
      shared.emitConnectionState(ConnectionState.Disconnected("Stream ended"))
      assertEquals(listOf(1), h.backoffAttempts)
      h.backoffGates.send(Unit)
      assertEquals(1, shared.connectCallCount)

      h.socketAvailable = true
      h.backoffGates.send(Unit)
      assertEquals(listOf(1, 2), h.backoffAttempts)
      // One reconnect for the device, not one per facet.
      assertEquals(2, shared.connectCallCount)
      assertTrue(facets.all { it.isConnected() })
    }

  @Test
  fun `a repeated connect retries a dropped connection without waiting for the backoff`() =
    runTest {
      val h = harness()
      val layout = h.hub.observationStream(phoneA).also { it.connect() }
      val shared = h.streamFor(phoneA)
      shared.emitConnectionState(ConnectionState.Error("socket closed"))

      layout.connect()
      assertEquals(2, shared.connectCallCount)
      assertEquals(mapOf(phoneA to 1), h.hub.observationSubscriptions.value)

      // The pending backoff finds the connection revived and leaves it alone.
      h.backoffGates.send(Unit)
      assertEquals(2, shared.connectCallCount)
    }

  @Test
  fun `the shared stream runs at the fastest cadence any facet requested`() = runTest {
    val h = harness()
    val slow = h.hub.observationStream(phoneA).also { it.connect() }
    val fast = h.hub.observationStream(phoneA).also { it.connect() }
    val shared = h.streamFor(phoneA)

    slow.setCadence(screenshotIntervalMs = 1_000, hierarchyIntervalMs = 2_000)
    fast.setCadence(screenshotIntervalMs = 250)
    assertEquals(250L to 2_000L, shared.cadenceCalls.last())

    fast.dispose()
    assertEquals(1_000L to 2_000L, shared.cadenceCalls.last())
    assertEquals(3, shared.cadenceCalls.size)
  }

  @Test
  fun `hub reconnects bump the facet's generation once per recovery`() = runTest {
    val h = harness()
    val layout = h.hub.observationStream(phoneA).also { it.connect() }
    val shared = h.streamFor(phoneA)
    var reconnects = 0
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
      countHubReconnects(layout) { reconnects++ }
    }
    assertEquals(0, reconnects)

    shared.emitConnectionState(ConnectionState.Disconnected("Stream ended"))
    h.backoffGates.send(Unit)
    assertEquals(1, reconnects)
  }

  @Test
  fun `a view's storage subscriptions ride its lease on the shared stream`() = runTest {
    val h = harness()
    val view = h.hub.observationStream(phoneA)

    // No lease yet: nothing to subscribe on.
    view.subscribeStorage("com.example", "prefs")
    view.connect()
    view.subscribeStorage("com.example", "prefs")

    assertEquals(
      setOf(StorageSubscriptionKey("com.example", "prefs")),
      h.streamFor(phoneA).storageSubscriptions,
    )
  }

  @Test
  fun `device control joining a live stream keeps and arms from the shared layout replay`() =
    runTest {
      val h = harness()
      val layout = h.hub.observationStream(phoneA).also { it.connect() }
      val shared = h.streamFor(phoneA)
      val hierarchy = HierarchyStreamUpdate(deviceId = "emulator-5554", timestamp = 1L, data = null)
      val screenshot = ScreenshotStreamUpdate("emulator-5554", 1L, "AA==", 1, 1)
      shared.emitHierarchy(hierarchy)
      shared.emitScreenshot(screenshot)

      // Control mounts on a static screen: no further frame will come.
      val control = h.hub.observationStream(phoneA).also { it.connect() }
      control.resetLayoutReplayCache()

      assertEquals(hierarchy, control.hierarchyUpdates.first())
      assertEquals(screenshot, control.screenshotUpdates.first())
      assertEquals(listOf(hierarchy), layout.hierarchyUpdates.replayCache)
      assertEquals(listOf(screenshot), layout.screenshotUpdates.replayCache)
      assertEquals(0, shared.observationRequestCount)
    }

  @Test
  fun `a lease resetting a live stream with no layout to replay asks for a fresh observation`() =
    runTest {
      val h = harness()
      val storage = h.hub.observationStream(phoneA).also { it.connect() }
      val control = h.hub.observationStream(phoneA).also { it.connect() }

      control.resetLayoutReplayCache()

      val shared = h.streamFor(phoneA)
      assertEquals(1, shared.observationRequestCount)
      assertEquals("emulator-5554", shared.lastObservationDeviceId)
      assertTrue(storage.isConnected())
    }

  @Test
  fun `a stream that is not connected drops its stale layout replay`() = runTest {
    val h = harness()
    val layout = h.hub.observationStream(phoneA).also { it.connect() }
    val shared = h.streamFor(phoneA)
    shared.emitHierarchy(
      HierarchyStreamUpdate(deviceId = "emulator-5554", timestamp = 1L, data = null),
    )
    shared.emitConnectionState(ConnectionState.Disconnected("daemon restarted"))

    layout.resetLayoutReplayCache()

    assertTrue(layout.hierarchyUpdates.replayCache.isEmpty())
    assertEquals(0, shared.observationRequestCount)
  }

  @Test
  fun `a hub reconnect drops the pre-outage layout before the stream reports connected`() =
    runTest {
      val h = harness()
      val layout = h.hub.observationStream(phoneA).also { it.connect() }
      val shared = h.streamFor(phoneA)
      shared.emitHierarchy(
        HierarchyStreamUpdate(deviceId = "emulator-5554", timestamp = 1L, data = null),
      )
      shared.emitScreenshot(ScreenshotStreamUpdate("emulator-5554", 1L, "AA==", 1, 1))

      shared.emitConnectionState(ConnectionState.Disconnected("Stream ended"))
      h.backoffGates.send(Unit)
      assertTrue(layout.isConnected())
      // The reconnected facet resets before any replacement frame arrived.
      layout.resetLayoutReplayCache()

      assertTrue(layout.hierarchyUpdates.replayCache.isEmpty())
      assertTrue(layout.screenshotUpdates.replayCache.isEmpty())
      assertEquals(1, shared.observationRequestCount)
    }

  @Test
  fun `closing the hub disposes every shared stream`() = runTest {
    val h = harness()
    val view = h.hub.observationStream(phoneA).also { it.connect() }
    h.hub.observationStream(phoneB).connect()

    h.hub.close()

    assertTrue(h.streams.all { it.disconnectCallCount == 1 })
    assertFalse(view.isConnected())
  }

  @Test
  fun `a reconnect counts even when the drop never shows in connection state`() = runTest {
    val h = harness()
    val layout = h.hub.observationStream(phoneA).also { it.connect() }
    val shared = h.streamFor(phoneA)

    // Dropped and revived before anything collects the state: a StateFlow conflates this away.
    shared.emitConnectionState(ConnectionState.Error("socket closed"))
    layout.connect()

    assertEquals(1, layout.reconnects.first())
    // A facet that leases afterwards counts only reconnects from its own lease on.
    val late = h.hub.observationStream(phoneA).also { it.connect() }
    assertEquals(0, late.reconnects.first())
  }

  /** Records connect/dispose order; reconnects (not the first connect) wait on [reconnectGate]. */
  private class GatedStream(private val inner: FakeObservationStream = FakeObservationStream()) :
    ObservationStream by inner {
    val calls = CopyOnWriteArrayList<String>()
    val reconnectStarted = CountDownLatch(1)
    val reconnectGate = CountDownLatch(1)

    override fun connect(deviceId: String?, deviceSessionUuid: String?) {
      if (calls.isNotEmpty()) {
        reconnectStarted.countDown()
        reconnectGate.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)
      }
      calls.add("connect")
      inner.connect(deviceId, deviceSessionUuid)
    }

    override fun dispose() {
      calls.add("dispose")
      inner.dispose()
    }

    fun drop() = inner.emitConnectionState(ConnectionState.Disconnected("Stream ended"))
  }

  @Test
  fun `releasing the last lease waits for an in-flight reconnect before disposing`() {
    val stream = GatedStream()
    val reconnectThread = Executors.newSingleThreadExecutor()
    val hub =
      SharedDaemonStreamHub(
        telemetry = FakeTelemetryMultiplexer(),
        scope = CoroutineScope(SupervisorJob() + reconnectThread.asCoroutineDispatcher()),
        observation =
          ObservationHubConfig(
            streamFactory = { stream },
            reconnect = ObservationReconnectPolicy(backoffDelay = {}, socketAvailable = { true }),
          ),
      )
    val layout = hub.observationStream(phoneA).also { it.connect() }

    stream.drop()
    assertTrue(stream.reconnectStarted.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
    val release = Thread { layout.dispose() }.also { it.start() }
    // Let the release reach disposal first: it either waits on the in-flight connect (BLOCKED) or,
    // without that serialization, disposes at once (TERMINATED).
    while (release.state != Thread.State.BLOCKED && release.state != Thread.State.TERMINATED) {
      Thread.onSpinWait()
    }
    stream.reconnectGate.countDown()
    release.join(TIMEOUT_SECONDS * 1_000)

    // The socket the reconnect opened is disposed, never orphaned by a dispose that ran first.
    assertEquals(listOf("connect", "connect", "dispose"), stream.calls.toList())
    hub.close()
    reconnectThread.shutdownNow()
  }

  private companion object {
    const val TIMEOUT_SECONDS = 5L
  }
}
