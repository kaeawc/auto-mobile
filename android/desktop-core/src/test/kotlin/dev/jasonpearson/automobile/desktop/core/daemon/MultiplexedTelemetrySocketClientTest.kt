package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The multiplexed telemetry client against a scripted in-memory daemon: no real socket, and every
 * wait is on a frame or state the test itself produces.
 */
class MultiplexedTelemetrySocketClientTest {
  // Real threads for the client: the scripted daemon is driven through blocking queues.
  private val clientThreads = Executors.newFixedThreadPool(CLIENT_THREADS).asCoroutineDispatcher()

  @After fun tearDown() = clientThreads.close()

  private val phoneA = DeviceStreamKey("emulator-5554", "uuid-a")
  private val phoneB = DeviceStreamKey("emulator-5556", "uuid-b")

  /** One end of a socket: the client reads [toClient] and writes into [fromClient]. */
  private class ScriptedSocket : TelemetrySocket {
    val toClient = LinkedBlockingQueue<String>()
    val fromClient = LinkedBlockingQueue<String>()

    override fun readLine(): String? = toClient.take().takeUnless { it == EOF }

    override fun writeLine(line: String) {
      fromClient.add(line)
    }

    override fun close() {
      toClient.add(EOF)
    }

    /** The next frame the client sent, decoded. */
    fun nextRequest(): Map<String, String?> {
      val line =
        checkNotNull(fromClient.poll(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
          "no request from client"
        }
      return Json.parseToJsonElement(line).jsonObject.mapValues { it.value.jsonPrimitive.content }
    }

    fun send(line: String) = toClient.add(line)

    companion object {
      const val EOF = "\u0000EOF"
    }
  }

  private class Daemon {
    private val opened = LinkedBlockingQueue<ScriptedSocket>()
    @Volatile var openCount = 0
    val readerThreads = CountingReaderThreads()
    val retryDelays = LinkedBlockingQueue<Long>()

    fun transport() =
      TelemetryTransport(
        openSocket = {
          openCount++
          ScriptedSocket().also(opened::add)
        },
        socketAvailable = { true },
        retryDelay = { retryDelays.add(it) },
        socketPath = { "/fake/telemetry-push.sock" },
      )

    /** The next socket the client opens. */
    fun nextSocket(): ScriptedSocket =
      checkNotNull(opened.poll(TIMEOUT_SECONDS, TimeUnit.SECONDS)) { "no socket opened" }
  }

  private fun ack(requestId: String?, subscriptionId: String) =
    """{"id":"$requestId","type":"subscription_response","success":true,"subscriptionId":"$subscriptionId"}"""

  private fun log(subscriptionId: String, message: String, key: DeviceStreamKey) =
    """{"type":"telemetry_push","subscriptionId":"$subscriptionId","data":{"category":"log","timestamp":1,"deviceId":"${key.deviceId}","deviceSessionUuid":"${key.deviceSessionUuid}","data":{"level":4,"tag":"t","message":"$message"}}}"""

  private class Sink {
    val events = LinkedBlockingQueue<TelemetryDisplayEvent>()

    fun next(): String =
      (checkNotNull(events.poll(TIMEOUT_SECONDS, TimeUnit.SECONDS)) as TelemetryDisplayEvent.Log)
        .message
  }

  // The client runs on real threads: the scripted daemon is driven through blocking queues, so
  // every wait ends on a frame or state the test produced, never on elapsed time.
  private fun client(daemon: Daemon) =
    MultiplexedTelemetrySocketClient(
      daemon.transport(),
      CoroutineScope(SupervisorJob() + clientThreads),
      TelemetryPushSocketOptions(readerThreads = daemon.readerThreads),
      newRequestId = RequestIds()::next,
    )

  private class RequestIds {
    private var next = 0

    @Synchronized fun next() = "req-${++next}"
  }

  @Test
  fun `forty devices share one socket and one reader thread`() = runBlocking {
    val daemon = Daemon()
    val client = client(daemon)
    val devices = (0 until 40).map { DeviceStreamKey("emulator-$it", "uuid-$it") }

    devices.forEach { client.subscribe(it) {} }
    val socket = daemon.nextSocket()
    val subscribed = (0 until 40).map { socket.nextRequest() }

    assertEquals(1, daemon.openCount)
    assertEquals(1, daemon.readerThreads.created)
    assertEquals(
      devices.map { it.deviceSessionUuid }.toSet(),
      subscribed.map { it["deviceSessionUuid"] }.toSet(),
    )
    assertTrue(subscribed.all { it["command"] == "subscribe" })
    client.close()
  }

  @Test
  fun `each device gets its own backfill, routed by subscription id`() = runBlocking {
    val daemon = Daemon()
    val client = client(daemon)
    val logsA = Sink()
    val logsB = Sink()
    client.subscribe(phoneA) { logsA.events.add(it) }
    client.subscribe(phoneB) { logsB.events.add(it) }
    val socket = daemon.nextSocket()
    val subA = socket.nextRequest()
    val subB = socket.nextRequest()

    // A busy device and a quiet one: each subscription carries its own device-scoped history.
    socket.send(ack(subA["id"], "telemetry-1"))
    socket.send(log("telemetry-1", "a-history", phoneA))
    socket.send(ack(subB["id"], "telemetry-2"))
    socket.send(log("telemetry-2", "b-history", phoneB))
    socket.send(log("telemetry-1", "a-live", phoneA))

    assertEquals("a-history", logsA.next())
    assertEquals("a-live", logsA.next())
    assertEquals("b-history", logsB.next())
    assertTrue(logsB.events.isEmpty())
    client.close()
  }

  @Test
  fun `a rejected device does not interrupt another device's events`() = runBlocking {
    val daemon = Daemon()
    val client = client(daemon)
    val logsA = Sink()
    val subscriptionB = client.subscribe(phoneB) {}
    client.subscribe(phoneA) { logsA.events.add(it) }
    val socket = daemon.nextSocket()
    val subB = socket.nextRequest()
    val subA = socket.nextRequest()

    socket.send(ack(subA["id"], "telemetry-1"))
    socket.send(
      """{"id":"${subB["id"]}","type":"error","success":false,"error":"deviceId 'emulator-5556' does not identify a live device session"}""",
    )
    socket.send(log("telemetry-1", "a1", phoneA))

    assertEquals("a1", logsA.next())
    assertEquals(
      ConnectionState.Error(TelemetryPushSocketClient.DEVICE_NOT_LIVE_MESSAGE),
      withTimeout(TIMEOUT_SECONDS * 1_000) {
        subscriptionB.state.first { it is ConnectionState.Error }
      },
    )
    // The rejected device subscribes again on its own after its backoff.
    daemon.retryDelays.poll(TIMEOUT_SECONDS, TimeUnit.SECONDS)
    val retried = socket.nextRequest()
    assertEquals("subscribe", retried["command"])
    assertEquals("uuid-b", retried["deviceSessionUuid"])
    assertEquals(1, daemon.openCount)
    client.close()
  }

  @Test
  fun `releasing a device unsubscribes its id and the last release closes the socket`() =
    runBlocking {
      val daemon = Daemon()
      val client = client(daemon)
      val a = client.subscribe(phoneA) {}
      val b = client.subscribe(phoneB) {}
      val socket = daemon.nextSocket()
      val subA = socket.nextRequest()
      val subB = socket.nextRequest()
      socket.send(ack(subA["id"], "telemetry-1"))
      socket.send(ack(subB["id"], "telemetry-2"))
      withTimeout(TIMEOUT_SECONDS * 1_000) { a.state.first { it is ConnectionState.Connected } }
      withTimeout(TIMEOUT_SECONDS * 1_000) { b.state.first { it is ConnectionState.Connected } }

      a.close()
      val unsubscribe = socket.nextRequest()
      assertEquals("unsubscribe", unsubscribe["command"])
      assertEquals("telemetry-1", unsubscribe["subscriptionId"])

      b.close()
      assertEquals("telemetry-2", socket.nextRequest()["subscriptionId"])
      assertEquals(ScriptedSocket.EOF, socket.toClient.poll(TIMEOUT_SECONDS, TimeUnit.SECONDS))
      client.close()
    }

  @Test
  fun `a reconnect re-subscribes every live device`() = runBlocking {
    val daemon = Daemon()
    val client = client(daemon)
    val logsB = Sink()
    client.subscribe(phoneA) {}
    client.subscribe(phoneB) { logsB.events.add(it) }
    val first = daemon.nextSocket()
    first.nextRequest()
    first.nextRequest()

    first.send(ScriptedSocket.EOF)
    daemon.retryDelays.poll(TIMEOUT_SECONDS, TimeUnit.SECONDS)
    val second = daemon.nextSocket()
    val resubscribed = listOf(second.nextRequest(), second.nextRequest())

    assertEquals(listOf("uuid-a", "uuid-b"), resubscribed.map { it["deviceSessionUuid"] })
    second.send(ack(resubscribed[1]["id"], "telemetry-9"))
    second.send(log("telemetry-9", "b-after-reconnect", phoneB))
    assertEquals("b-after-reconnect", logsB.next())
    client.close()
  }

  @Test
  fun `the hub shows each pane its own device's logs over one socket`() = runBlocking {
    val daemon = Daemon()
    val hub = SharedDaemonStreamHub(client(daemon), CoroutineScope(SupervisorJob() + clientThreads))
    val devices = (0 until 40).map { DeviceStreamKey("emulator-$it", "uuid-$it") }
    val panes = devices.associateWith { Sink() }
    devices.forEach { key -> hub.subscribeTelemetry(key) { panes.getValue(key).events.add(it) } }
    val socket = daemon.nextSocket()
    val requests = (0 until 40).map { socket.nextRequest() }

    // Only device 0 is busy; the quiet device 39 still gets its own backfilled history.
    val busy = requests.single { it["deviceSessionUuid"] == "uuid-0" }
    val quiet = requests.single { it["deviceSessionUuid"] == "uuid-39" }
    socket.send(ack(busy["id"], "telemetry-1"))
    socket.send(ack(quiet["id"], "telemetry-2"))
    repeat(3) { socket.send(log("telemetry-1", "busy-$it", devices[0])) }
    socket.send(log("telemetry-2", "quiet-history", devices[39]))

    assertEquals(
      listOf("busy-0", "busy-1", "busy-2"),
      List(3) { panes.getValue(devices[0]).next() },
    )
    assertEquals("quiet-history", panes.getValue(devices[39]).next())
    assertEquals(1, daemon.openCount)
    assertEquals(1, daemon.readerThreads.created)
    hub.close()
  }
}

private const val TIMEOUT_SECONDS = 5L
private const val CLIENT_THREADS = 4

/** Counts reader threads created, handing out real single-thread dispatchers. */
internal class CountingReaderThreads : StreamReaderDispatcherFactory {
  @Volatile var created = 0

  override fun create(name: String): ExecutorCoroutineDispatcher {
    created++
    return DedicatedStreamReaderThreads.create(name)
  }
}
