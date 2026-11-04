package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

/**
 * The multiplexed observation client against a scripted in-memory daemon: no real socket, and every
 * wait is on a frame or state the test itself produces.
 */
class MultiplexedObservationSocketClientTest {
  // Real threads for the client: the scripted daemon is driven through blocking queues.
  private val clientThreads = Executors.newFixedThreadPool(CLIENT_THREADS).asCoroutineDispatcher()

  @After fun tearDown() = clientThreads.close()

  /** One end of a socket: the client reads [toClient] and writes into [fromClient]. */
  private class ScriptedSocket : TelemetrySocket {
    val toClient = LinkedBlockingQueue<String>()
    val fromClient = LinkedBlockingQueue<String>()
    val closes = LinkedBlockingQueue<Unit>()

    override fun readLine(): String? = toClient.take().takeUnless { it == EOF }

    override fun writeLine(line: String) {
      fromClient.add(line)
    }

    override fun close() {
      toClient.add(EOF)
      closes.add(Unit)
    }

    fun awaitClosed() =
      checkNotNull(closes.poll(TIMEOUT_SECONDS, TimeUnit.SECONDS)) { "socket not closed" }

    /** The next frame the client sent, decoded. */
    fun nextRequest(): Map<String, String?> {
      val line =
        checkNotNull(fromClient.poll(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
          "no request from client"
        }
      return Json.parseToJsonElement(line).jsonObject.mapValues { it.value.jsonPrimitive.content }
    }

    /** The next [count] `subscribe`s keyed by device epoch; concurrent connects race on order. */
    fun nextSubscribes(count: Int): Map<String?, Map<String, String?>> =
      List(count) { nextRequest() }
        .onEach { assertEquals("subscribe", it["command"]) }
        .associateBy { it["deviceSessionUuid"] }

    fun send(line: String) = toClient.add(line)

    /** End the connection from the daemon's side. */
    fun drop() = toClient.add(EOF)

    companion object {
      const val EOF = "\u0000EOF"
    }
  }

  private class Daemon {
    private val opened = LinkedBlockingQueue<ScriptedSocket>()
    @Volatile var openCount = 0
    val readerThreads = CountingReaderThreads()

    fun transport() =
      ObservationMuxTransport(
        openSocket = {
          openCount++
          ScriptedSocket().also(opened::add)
        },
        socketAvailable = { true },
        socketPath = { "/fake/observation-stream.sock" },
        readerThreads = readerThreads,
      )

    fun nextSocket(): ScriptedSocket =
      checkNotNull(opened.poll(TIMEOUT_SECONDS, TimeUnit.SECONDS)) { "no socket opened" }
  }

  private class RequestIds {
    private var next = 0

    @Synchronized fun next() = "req-${++next}"
  }

  private fun client(daemon: Daemon) =
    MultiplexedObservationSocketClient(
      daemon.transport(),
      CoroutineScope(SupervisorJob() + clientThreads),
      newRequestId = RequestIds()::next,
    )

  private fun ack(requestId: String?, subscriptionId: String) =
    """{"id":"$requestId","type":"subscription_response","success":true,"subscriptionId":"$subscriptionId"}"""

  private fun hierarchy(subscriptionId: String, deviceId: String, timestamp: Long) =
    """{"type":"hierarchy_update","subscriptionId":"$subscriptionId","deviceId":"$deviceId","timestamp":$timestamp,"data":{"packageName":"com.$deviceId"}}"""

  private fun performance(subscriptionId: String, deviceId: String, fps: Int) =
    """{"type":"performance_update","subscriptionId":"$subscriptionId","deviceId":"$deviceId","timestamp":1,"performanceData":{"fps":$fps,"frameTimeMs":10,"jankFrames":1,"droppedFrames":0,"memoryUsageMb":1,"cpuUsagePercent":1}}"""

  private suspend fun <T> Flow<T>.awaitFirst(predicate: (T) -> Boolean = { true }): T =
    withTimeout(TIMEOUT_SECONDS * 1_000) { first(predicate) }

  /** Connect [streams] for devices `uuid-0..n`, ack each, and return their subscription ids. */
  private fun subscribeAll(socket: ScriptedSocket, streams: List<ObservationStream>): List<String> {
    val subscribes = socket.nextSubscribes(streams.size)
    return streams.indices.map { index ->
      "devicedatastream-$index"
        .also {
          socket.send(ack(subscribes.getValue("uuid-$index")["id"], it))
        }
    }
  }

  private fun connectDevices(mux: ObservationMultiplexer, count: Int) =
    List(count) { index ->
      mux.stream().also {
        it.connect(deviceId = "emulator-$index", deviceSessionUuid = "uuid-$index")
      }
    }

  @Test
  fun `forty observed devices on the hub share one socket and one reader thread`() = runBlocking {
    val daemon = Daemon()
    val mux = client(daemon)
    val hubScope = CoroutineScope(SupervisorJob() + clientThreads)
    val hub =
      SharedDaemonStreamHub(
        telemetryClientFactory = { FakeTelemetryPushClient() },
        scope = hubScope,
        observation =
          ObservationHubConfig(
            streamFactory = mux::stream,
            reconnect = ObservationReconnectPolicy({ awaitCancellation() }, { true }),
          ),
      )
    val devices = (0 until 40).map { DeviceStreamKey("emulator-$it", "uuid-$it") }

    // Layout open on every device.
    devices.forEach { hub.observationStream(it).connect() }
    val socket = daemon.nextSocket()
    val subscribes = socket.nextSubscribes(40)

    daemon.readerThreads.awaitFirst()
    assertEquals(1, daemon.openCount)
    assertEquals(1, daemon.readerThreads.created)
    assertEquals(devices.map { it.deviceSessionUuid }.toSet(), subscribes.keys)
    hub.close()
    mux.close()
  }

  @Test
  fun `each device receives only its own layout, performance and navigation`() = runBlocking {
    val daemon = Daemon()
    val mux = client(daemon)
    val (a, b) = connectDevices(mux, 2)
    val socket = daemon.nextSocket()
    val (subA, subB) = subscribeAll(socket, listOf(a, b))
    a.connectionState.awaitFirst { it is ConnectionState.Connected }

    socket.send(hierarchy(subB, "emulator-1", 20))
    socket.send(performance(subB, "emulator-1", 30))
    socket.send(hierarchy(subA, "emulator-0", 10))
    socket.send(performance(subA, "emulator-0", 50))
    // A navigation reply names only the request that asked for it.
    b.requestNavigationGraph("com.b")
    val navRequest = socket.nextRequest()
    assertEquals("request_navigation_graph", navRequest["command"])
    assertEquals("uuid-1", navRequest["deviceSessionUuid"])
    socket.send(
      """{"id":"${navRequest["id"]}","type":"navigation_update","timestamp":1,"navigationGraph":{"appId":"com.b","nodes":[],"edges":[],"currentScreen":"Home"}}""",
    )

    assertEquals(10L, a.hierarchyUpdates.awaitFirst().timestamp)
    assertEquals(50f, a.performanceUpdates.awaitFirst().fps)
    assertEquals(20L, b.hierarchyUpdates.awaitFirst().timestamp)
    assertEquals(30f, b.performanceUpdates.awaitFirst().fps)
    assertEquals("com.b", b.navigationUpdates.awaitFirst().appId)
    assertEquals(listOf(10L), a.hierarchyUpdates.replayCache.map { it.timestamp })
    assertTrue(a.navigationUpdates.replayCache.isEmpty())
    mux.close()
  }

  @Test
  fun `a refused or ended subscription does not interrupt another device`() = runBlocking {
    val daemon = Daemon()
    val mux = client(daemon)
    val (a, b, c) = connectDevices(mux, 3)
    val socket = daemon.nextSocket()
    val subscribes = socket.nextSubscribes(3)
    socket.send(ack(subscribes.getValue("uuid-0")["id"], "devicedatastream-0"))
    socket.send(ack(subscribes.getValue("uuid-2")["id"], "devicedatastream-2"))
    socket.send(
      """{"id":"${subscribes.getValue("uuid-1")["id"]}","type":"error","success":false,"error":"deviceSessionUuid 'uuid-1' is not live"}""",
    )
    socket.send(
      """{"type":"error","success":false,"code":"BACKFILL_QUEUE_OVERFLOW","subscriptionId":"devicedatastream-2","error":"Backfill overflow"}""",
    )
    socket.send(hierarchy("devicedatastream-0", "emulator-0", 7))

    assertEquals(7L, a.hierarchyUpdates.awaitFirst().timestamp)
    assertEquals(
      ConnectionState.Disconnected("deviceSessionUuid 'uuid-1' is not live"),
      b.connectionState.awaitFirst { it is ConnectionState.Disconnected },
    )
    assertEquals(
      ConnectionState.Disconnected("Backfill overflow"),
      c.connectionState.awaitFirst { it is ConnectionState.Disconnected },
    )
    assertTrue(a.isConnected())

    // The refused device subscribes again on the same socket when its owner retries.
    b.connect(deviceId = "emulator-1", deviceSessionUuid = "uuid-1")
    val retried = socket.nextRequest()
    assertEquals("subscribe", retried["command"])
    assertEquals("uuid-1", retried["deviceSessionUuid"])
    assertEquals(1, daemon.openCount)
    mux.close()
  }

  @Test
  fun `cadence is sent on the device's own subscription, including one set mid-subscribe`() =
    runBlocking {
      val daemon = Daemon()
      val mux = client(daemon)
      val stream = mux.stream()
      stream.setCadence(screenshotIntervalMs = 500L)
      stream.connect(deviceId = "emulator-0", deviceSessionUuid = "uuid-0")
      val socket = daemon.nextSocket()
      val subscribe = socket.nextRequest()
      assertEquals("500", subscribe["screenshotIntervalMs"])

      // Changed while the subscribe is in flight: sent as soon as the daemon names the id.
      stream.setCadence(screenshotIntervalMs = 100L)
      socket.send(ack(subscribe["id"], "devicedatastream-7"))
      val update = socket.nextRequest()
      assertEquals("update_cadence", update["command"])
      assertEquals("devicedatastream-7", update["subscriptionId"])
      assertEquals("100", update["screenshotIntervalMs"])

      stream.setCadence(screenshotIntervalMs = 100L, hierarchyIntervalMs = 250L)
      val next = socket.nextRequest()
      assertEquals("devicedatastream-7", next["subscriptionId"])
      assertEquals("250", next["hierarchyIntervalMs"])
      mux.close()
    }

  @Test
  fun `releasing unsubscribes the device, a late ack is unsubscribed, the last closes the socket`() =
    runBlocking {
      val daemon = Daemon()
      val mux = client(daemon)
      val (a, b) = connectDevices(mux, 2)
      val socket = daemon.nextSocket()
      val subscribes = socket.nextSubscribes(2)
      socket.send(ack(subscribes.getValue("uuid-0")["id"], "devicedatastream-0"))
      a.connectionState.awaitFirst { it is ConnectionState.Connected }

      // Released while its subscribe is still in flight.
      b.dispose()
      // Frames for the remaining device still flow.
      socket.send(hierarchy("devicedatastream-0", "emulator-0", 1))
      a.hierarchyUpdates.awaitFirst()
      socket.send(ack(subscribes.getValue("uuid-1")["id"], "devicedatastream-1"))
      val late = socket.nextRequest()
      assertEquals("unsubscribe", late["command"])
      assertEquals("devicedatastream-1", late["subscriptionId"])

      a.dispose()
      val released = socket.nextRequest()
      assertEquals("unsubscribe", released["command"])
      assertEquals("devicedatastream-0", released["subscriptionId"])
      socket.awaitClosed()
      assertEquals(ConnectionState.Disconnected(), a.connectionState.value)
      mux.close()
    }

  @Test
  fun `a dropped socket takes every device down, and reconnecting reopens it once`() = runBlocking {
    val daemon = Daemon()
    val mux = client(daemon)
    val streams = connectDevices(mux, 2)
    val first = daemon.nextSocket()
    subscribeAll(first, streams)
    streams.forEach { s -> s.connectionState.awaitFirst { it is ConnectionState.Connected } }

    first.drop()
    streams.forEach { s ->
      assertEquals(
        ConnectionState.Disconnected("Stream ended"),
        s.connectionState.awaitFirst { it is ConnectionState.Disconnected },
      )
    }

    streams.forEachIndexed { index, s ->
      s.connect(deviceId = "emulator-$index", deviceSessionUuid = "uuid-$index")
    }
    val second = daemon.nextSocket()
    val (subA, _) = subscribeAll(second, streams)
    second.send(hierarchy(subA, "emulator-0", 99))
    assertEquals(99L, streams[0].hierarchyUpdates.awaitFirst { it.timestamp == 99L }.timestamp)
    assertEquals(2, daemon.openCount)
    mux.close()
  }

  @Test
  fun `device connection lost reaches only its device and clears its stale layout`() = runBlocking {
    val daemon = Daemon()
    val mux = client(daemon)
    val (a, b) = connectDevices(mux, 2)
    val socket = daemon.nextSocket()
    val (subA, subB) = subscribeAll(socket, listOf(a, b))
    socket.send(hierarchy(subA, "emulator-0", 1))
    socket.send(hierarchy(subB, "emulator-1", 2))
    a.hierarchyUpdates.awaitFirst()
    b.hierarchyUpdates.awaitFirst()

    socket.send(
      """{"type":"error","success":false,"subscriptionId":"$subA","deviceId":"emulator-0","timestamp":3,"error":"$DEVICE_CONNECTION_LOST_ERROR"}""",
    )

    val event = a.deviceEvents.awaitFirst() as DeviceStreamEvent.DeviceConnectionLost
    assertEquals("emulator-0", event.deviceId)
    assertTrue(a.hierarchyUpdates.replayCache.isEmpty())
    assertEquals(listOf(2L), b.hierarchyUpdates.replayCache.map { it.timestamp })
    assertTrue(b.deviceEvents.replayCache.isEmpty())
    assertTrue(a.isConnected())
    mux.close()
  }

  @Test
  fun `a refused desktop session fails every device`() = runBlocking {
    val daemon = Daemon()
    val mux = client(daemon)
    val (a, b) = connectDevices(mux, 2)
    val socket = daemon.nextSocket()
    val subscribes = socket.nextSubscribes(2)

    socket.send(
      """{"id":"${subscribes.getValue("uuid-0")["id"]}","type":"error","success":false,"error":"Observation stream requires an authenticated daemon session"}""",
    )

    listOf(a, b).forEach { s ->
      assertTrue(
        s.connectionState.awaitFirst { it is ConnectionState.Error } is ConnectionState.Error,
      )
    }
    socket.awaitClosed()
    // Refused for good while these leases are held: a retry sends nothing.
    a.connect(deviceId = "emulator-0", deviceSessionUuid = "uuid-0")
    assertTrue(a.connectionState.value is ConnectionState.Error)
    assertNull(socket.fromClient.poll())
    mux.close()
  }

  companion object {
    private const val TIMEOUT_SECONDS = 5L
    private const val CLIENT_THREADS = 4

    /**
     * Run one subscribe, frame and release end to end before the tests, so class loading, the
     * serializers and the coroutine machinery are not billed to whichever test runs first.
     */
    @JvmStatic
    @BeforeClass
    fun warmUp() {
      Executors.newSingleThreadExecutor().asCoroutineDispatcher().use { thread ->
        val daemon = Daemon()
        val mux =
          MultiplexedObservationSocketClient(
            daemon.transport(),
            CoroutineScope(SupervisorJob() + thread),
          )
        val stream = mux.stream()
        stream.connect(deviceId = "warm", deviceSessionUuid = "uuid-warm")
        val socket = daemon.nextSocket()
        val subscribe = socket.nextRequest()
        socket.send(
          """{"id":"${subscribe["id"]}","type":"subscription_response","success":true,"subscriptionId":"s"}""",
        )
        socket.send(
          """{"type":"hierarchy_update","subscriptionId":"s","deviceId":"warm","timestamp":1}""",
        )
        runBlocking { withTimeout(TIMEOUT_SECONDS * 1_000) { stream.hierarchyUpdates.first() } }
        stream.dispose()
        mux.close()
      }
    }
  }
}
