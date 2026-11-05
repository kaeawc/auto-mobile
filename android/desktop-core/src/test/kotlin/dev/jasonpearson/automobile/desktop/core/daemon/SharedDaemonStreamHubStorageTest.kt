package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.domain.KeyValueType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Storage traffic on the hub's shared per-device observation stream (#17012). */
@OptIn(ExperimentalCoroutinesApi::class)
class SharedDaemonStreamHubStorageTest {
  private val phone = DeviceStreamKey("emulator-5554", "uuid-a")
  private val prefs = StorageSubscriptionKey("com.example", "prefs.xml")
  private val flags = StorageSubscriptionKey("com.example", "flags.xml")

  private class Harness(scope: CoroutineScope) {
    val streams = mutableListOf<FakeObservationStream>()
    private var nextId = 0
    val hub =
      SharedDaemonStreamHub(
        telemetry = FakeTelemetryMultiplexer(),
        scope = scope,
        observation =
          ObservationHubConfig(
            streamFactory = { FakeObservationStream().also { streams.add(it) } },
            reconnect = ObservationReconnectPolicy({ awaitCancellation() }, { true }),
            newRequestId = { "hub-${++nextId}" },
          ),
      )

    val shared: FakeObservationStream
      get() = streams.single()
  }

  /** What one pane's lease received. */
  private class Pane(val stream: ObservationStream) {
    val responses = mutableListOf<StorageSubscriptionResponse>()
    val updates = mutableListOf<StorageStreamUpdate>()
    val reconciliations = mutableListOf<StorageSubscriptionKey>()
  }

  private fun TestScope.harness() =
    Harness(
      CoroutineScope(backgroundScope.coroutineContext + UnconfinedTestDispatcher(testScheduler)),
    )

  /** A hub whose coroutines run only on [runCurrent], so connection states can be conflated. */
  private fun TestScope.queuedHarness() =
    Harness(
      CoroutineScope(backgroundScope.coroutineContext + StandardTestDispatcher(testScheduler)),
    )

  private fun TestScope.pane(h: Harness): Pane {
    val pane = Pane(h.hub.observationStream(phone).also { it.connect() })
    val dispatcher = UnconfinedTestDispatcher(testScheduler)
    backgroundScope.launch(dispatcher) {
      pane.stream.storageSubscriptionResponses.toList(pane.responses)
    }
    backgroundScope.launch(dispatcher) { pane.stream.storageUpdates.toList(pane.updates) }
    backgroundScope.launch(dispatcher) {
      pane.stream.storageReconciliationRequests.toList(pane.reconciliations)
    }
    return pane
  }

  private fun ack(requestId: String, key: StorageSubscriptionKey, subscribe: Boolean = true) =
    StorageSubscriptionResponse(requestId, key, subscribe = subscribe, success = true)

  private fun update(key: StorageSubscriptionKey, sequence: Long) =
    StorageStreamUpdate(
      deviceId = phone.deviceId,
      timestamp = sequence,
      packageName = key.packageName,
      fileName = key.fileName,
      key = "k",
      value = "v$sequence",
      valueType = KeyValueType.Unknown,
      sequenceNumber = sequence,
    )

  @Test
  fun `storage, layout and device control on one device share one observation connection`() =
    runTest {
      val h = harness()
      val storage = pane(h)
      h.hub.observationStream(phone).connect() // Layout
      h.hub.observationStream(phone).apply {
        connect()
        setCadence(screenshotIntervalMs = 5_000L, hierarchyIntervalMs = 5_000L)
      } // device control

      storage.stream.subscribeStorage(prefs.packageName, prefs.fileName)

      assertEquals(1, h.streams.size)
      assertEquals(1, h.shared.connectCallCount)
      assertEquals(mapOf(phone to 3), h.hub.observationSubscriptions.value)
      assertEquals(setOf(prefs), h.shared.storageSubscriptions)
    }

  @Test
  fun `two storage panes get only their own files' acknowledgements and updates`() = runTest {
    val h = harness()
    val a = pane(h)
    val b = pane(h)
    a.stream.subscribeStorage(prefs.packageName, prefs.fileName)
    b.stream.subscribeStorage(flags.packageName, flags.fileName)

    h.shared.emitStorageSubscriptionResponse(ack("req-1", prefs))
    h.shared.emitStorageSubscriptionResponse(ack("req-2", flags))
    h.shared.emitStorage(update(prefs, 1))
    h.shared.emitStorage(update(flags, 2))
    h.shared.emitStorage(update(prefs, 3))
    h.shared.emitStorageReconciliationRequest(flags)

    assertEquals(listOf(ack("req-1", prefs)), a.responses)
    assertEquals(listOf(ack("req-2", flags)), b.responses)
    assertEquals(listOf(1L, 3L), a.updates.map { it.sequenceNumber })
    assertEquals(listOf(2L), b.updates.map { it.sequenceNumber })
    assertTrue(a.reconciliations.isEmpty())
    assertEquals(listOf(flags), b.reconciliations)
  }

  @Test
  fun `a file shared by two panes is subscribed once and acknowledged to each`() = runTest {
    val h = harness()
    val a = pane(h)
    val b = pane(h)
    val c = pane(h)

    // B joins while A's subscribe is in flight: the one acknowledgement answers both.
    a.stream.subscribeStorage(prefs.packageName, prefs.fileName)
    b.stream.subscribeStorage(prefs.packageName, prefs.fileName)
    h.shared.emitStorageSubscriptionResponse(ack("req-1", prefs))
    // C joins a file already observed: acknowledged at once, so it reconciles its snapshot.
    c.stream.subscribeStorage(prefs.packageName, prefs.fileName)
    h.shared.emitStorage(update(prefs, 7))

    assertEquals(listOf("subscribe_storage" to prefs), h.shared.storageSubscriptionCalls)
    assertEquals(listOf(ack("req-1", prefs)), a.responses)
    assertEquals(listOf(ack("req-1", prefs)), b.responses)
    assertEquals(listOf(ack("hub-1", prefs)), c.responses)
    listOf(a, b, c).forEach { assertEquals(listOf(7L), it.updates.map { u -> u.sequenceNumber }) }
  }

  @Test
  fun `unmounting releases the lease and only the storage subscriptions it alone held`() = runTest {
    val h = harness()
    val a = pane(h)
    val b = pane(h)
    a.stream.subscribeStorage(prefs.packageName, prefs.fileName)
    a.stream.subscribeStorage(flags.packageName, flags.fileName)
    b.stream.subscribeStorage(prefs.packageName, prefs.fileName)

    a.stream.dispose()

    assertEquals(mapOf(phone to 1), h.hub.observationSubscriptions.value)
    assertEquals(setOf(prefs), h.shared.storageSubscriptions)
    // A's unsubscribe acknowledgement answers nobody; B still gets its file's updates.
    h.shared.emitStorageSubscriptionResponse(ack("req-3", flags, subscribe = false))
    h.shared.emitStorage(update(prefs, 4))
    assertTrue(b.responses.isEmpty())
    assertEquals(listOf(4L), b.updates.map { it.sequenceNumber })

    b.stream.dispose()
    assertEquals(emptyMap<DeviceStreamKey, Int>(), h.hub.observationSubscriptions.value)
    assertEquals(1, h.shared.disconnectCallCount)
  }

  @Test
  fun `a dropped connection forgets confirmations, so a joining pane waits for the re-ack`() =
    runTest {
      val h = harness()
      val a = pane(h)
      a.stream.subscribeStorage(prefs.packageName, prefs.fileName)
      h.shared.emitStorageSubscriptionResponse(ack("req-1", prefs))

      h.shared.emitConnectionState(
        dev.jasonpearson.automobile.desktop.core.connection.ConnectionState.Disconnected("x"),
      )
      val b = pane(h)
      b.stream.subscribeStorage(prefs.packageName, prefs.fileName)
      assertTrue(b.responses.isEmpty())

      // The re-registration after the reconnect acknowledges every holder.
      h.shared.emitStorageSubscriptionResponse(ack("req-2", prefs))
      assertEquals(listOf(ack("req-1", prefs), ack("req-2", prefs)), a.responses)
      assertEquals(listOf(ack("req-2", prefs)), b.responses)
    }

  @Test
  fun `a pane joining a file whose registration failed registers it again`() = runTest {
    val h = harness()
    val a = pane(h)
    a.stream.subscribeStorage(prefs.packageName, prefs.fileName)
    val refused =
      StorageSubscriptionResponse("req-1", prefs, subscribe = true, success = false, error = "busy")
    h.shared.emitStorageSubscriptionResponse(refused)
    assertEquals(listOf(refused), a.responses)

    val b = pane(h)
    b.stream.subscribeStorage(prefs.packageName, prefs.fileName)

    assertEquals(
      listOf(
        "subscribe_storage" to prefs,
        "unsubscribe_storage" to prefs,
        "subscribe_storage" to prefs,
      ),
      h.shared.storageSubscriptionCalls,
    )
    h.shared.emitStorageSubscriptionResponse(ack("req-2", prefs))
    assertEquals(listOf(ack("req-2", prefs)), b.responses)
    assertEquals(listOf(refused, ack("req-2", prefs)), a.responses)
  }

  @Test
  fun `a reconnect whose drop the hub never saw still forgets confirmations`() = runTest {
    val h = queuedHarness()
    val a = pane(h)
    a.stream.subscribeStorage(prefs.packageName, prefs.fileName)
    runCurrent()
    h.shared.emitStorageSubscriptionResponse(ack("req-1", prefs))
    runCurrent()

    // The drop and the reconnect land before the hub collects either state: only the conflated
    // Connected is seen, so the reconnect call itself must forget the old registration.
    h.shared.emitConnectionState(ConnectionState.Disconnected("x"))
    a.stream.connect()
    runCurrent()
    assertEquals(2, h.shared.connectCallCount)

    val b = pane(h)
    b.stream.subscribeStorage(prefs.packageName, prefs.fileName)
    runCurrent()
    assertTrue(b.responses.isEmpty())
    h.shared.emitStorageSubscriptionResponse(ack("req-2", prefs))
    runCurrent()
    assertEquals(listOf(ack("req-2", prefs)), b.responses)
  }

  @Test
  fun `a pane joining while the stream is down waits instead of taking a stale confirmation`() =
    runTest {
      val h = queuedHarness()
      val a = pane(h)
      a.stream.subscribeStorage(prefs.packageName, prefs.fileName)
      runCurrent()
      h.shared.emitStorageSubscriptionResponse(ack("req-1", prefs))
      runCurrent()

      // Down, but the hub has not collected the drop yet.
      h.shared.emitConnectionState(ConnectionState.Disconnected("x"))
      val b = pane(h)
      b.stream.subscribeStorage(prefs.packageName, prefs.fileName)
      runCurrent()

      assertTrue(b.responses.isEmpty())
    }
}
