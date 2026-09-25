package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.logging.Logger
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TelemetryPushSocketClientTest {
  private class RecordingLogger : Logger {
    val warnings = mutableListOf<String>()

    override fun info(message: String) = Unit

    override fun warn(message: String) {
      warnings.add(message)
    }

    override fun warn(message: String, throwable: Throwable) {
      warnings.add(message)
    }

    override fun error(message: String) = Unit

    override fun error(message: String, throwable: Throwable) = Unit

    override fun debug(message: String) = Unit
  }

  @Test
  fun `malformed message is skipped and recovered field warning is deduplicated`() = runTest {
    val logger = RecordingLogger()
    val client = TelemetryPushSocketClient({ FakeSocket() }, {}, backgroundScope, { true }, logger)
    val valid =
      """{"type":"telemetry_push","data":{"category":"navigation","timestamp":1,"data":{"destination":"screen","arguments":{"id":"42","options":{"tab":"home"}}}}}"""
    val malformed = """{"type":"telemetry_push","data":{"timestamp":1,"data":{}}}"""

    assertFalse(client.processMessage(malformed))
    assertTrue(client.processMessage(valid))
    assertTrue(client.processMessage(valid))

    val events = client.telemetryEvents.replayCache
    assertEquals(2, events.size)
    assertEquals("screen", (events.last() as TelemetryDisplayEvent.Navigation).destination)
    assertEquals(1, logger.warnings.count { it.contains("Malformed telemetry push message") })
    assertEquals(1, logger.warnings.count { it.contains("category=navigation field=arguments") })
    client.dispose()
  }

  private class FakeRetryDelay : TelemetryRetryDelay {
    val calls = mutableListOf<Long>()

    override suspend fun wait(delayMs: Long) {
      calls.add(delayMs)
    }
  }

  private class FakeSocket(private val lines: List<String> = emptyList()) : TelemetrySocket {
    private val remaining = ArrayDeque(lines)

    override fun readLine(): String? = remaining.removeFirstOrNull()

    override fun writeLine(line: String) = Unit

    override fun close() = Unit
  }

  private class SilentFakeSocket(private val finishInterruptedRead: CountDownLatch? = null) :
    TelemetrySocket {
    val readEntered = CompletableDeferred<Unit>()
    val readInterrupted = CompletableDeferred<Unit>()
    val closed = CompletableDeferred<Unit>()
    val closeCount = AtomicInteger()
    private val closeGate = CountDownLatch(1)

    override fun readLine(): String? {
      readEntered.complete(Unit)
      try {
        closeGate.await()
      } catch (e: InterruptedException) {
        readInterrupted.complete(Unit)
        if (finishInterruptedRead != null) {
          Thread.interrupted()
          finishInterruptedRead.await()
        }
        throw e
      }
      return null
    }

    override fun writeLine(line: String) = Unit

    override fun close() {
      closeCount.incrementAndGet()
      closeGate.countDown()
      closed.complete(Unit)
    }
  }

  @Test
  fun `dataless accepts increase attempt and backoff`() = runTest {
    val delays = FakeRetryDelay()
    val client = TelemetryPushSocketClient({ FakeSocket() }, delays, backgroundScope, { true })
    val states = mutableListOf<ConnectionState>()
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
      client.connectionState.collect { states.add(it) }
    }

    client.connect()
    runCurrent()
    client.connectionState.first { it is ConnectionState.Error }

    assertEquals(
      listOf(1, 2, 3, 4),
      states.filterIsInstance<ConnectionState.Reconnecting>().map { it.attempt },
    )
    assertEquals(4, delays.calls.size)
    assertTrue(delays.calls[1] > delays.calls[0])
    assertTrue(delays.calls[2] > delays.calls[1])
    assertFalse(states.any { it is ConnectionState.Connected })
    client.dispose()
  }

  @Test
  fun `five consecutive dataless flaps end in terminal error`() = runTest {
    var opens = 0
    val client =
      TelemetryPushSocketClient(
        {
          opens++
          FakeSocket()
        },
        {},
        backgroundScope,
        { true },
      )

    client.connect()
    runCurrent()
    client.connectionState.first { it is ConnectionState.Error }

    assertEquals(TelemetryPushSocketClient.MAX_RECONNECT_ATTEMPTS, opens)
    assertEquals(
      ConnectionState.Error("Telemetry unavailable on this daemon"),
      client.connectionState.replayCache.single(),
    )
    client.dispose()
  }

  @Test
  fun `successful subscription resets attempts and emits Connected`() = runTest {
    var opens = 0
    val states = mutableListOf<ConnectionState>()
    val client =
      TelemetryPushSocketClient(
        {
          opens++
          if (opens == 2) FakeSocket(listOf("""{"type":"subscription_response","success":true}"""))
          else FakeSocket()
        },
        {},
        backgroundScope,
        { true },
      )
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
      client.connectionState.collect { states.add(it) }
    }

    client.connect()
    runCurrent()
    client.connectionState.first { it is ConnectionState.Error }

    assertTrue(states.contains(ConnectionState.Connected(subscribed = true)))
    assertEquals(
      listOf(1, 1, 2, 3, 4),
      states.filterIsInstance<ConnectionState.Reconnecting>().map { it.attempt },
    )
    client.dispose()
  }

  @Test
  fun `manual Retry after Error starts a fresh cycle`() = runTest {
    var opens = 0
    val states = mutableListOf<ConnectionState>()
    val client =
      TelemetryPushSocketClient(
        {
          opens++
          FakeSocket()
        },
        {},
        backgroundScope,
        { true },
      )
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
      client.connectionState.collect { states.add(it) }
    }

    client.connect()
    runCurrent()
    client.connectionState.first { it is ConnectionState.Error }
    assertTrue(states.last() is ConnectionState.Error)
    client.connect()
    runCurrent()
    client.connectionState.first { it is ConnectionState.Error }

    assertEquals(2 * TelemetryPushSocketClient.MAX_RECONNECT_ATTEMPTS, opens)
    assertEquals(2, states.count { it is ConnectionState.Connecting })
    assertEquals(2, states.count { it is ConnectionState.Reconnecting && it.attempt == 1 })
    client.dispose()
  }

  @Test
  fun `reconnect interrupts the old read without closing the new socket`() = runTest {
    val finishInterruptedRead = CountDownLatch(1)
    val firstSocket = SilentFakeSocket(finishInterruptedRead)
    val secondSocket = SilentFakeSocket()
    val sockets = ArrayDeque(listOf(firstSocket, secondSocket))
    val client = TelemetryPushSocketClient({ sockets.removeFirst() }, {}, backgroundScope, { true })

    client.connect()
    runCurrent()
    firstSocket.readEntered.await()

    client.connect()
    runCurrent()
    firstSocket.readInterrupted.await()
    secondSocket.readEntered.await()
    try {
      assertFalse(firstSocket.closed.isCompleted)
    } finally {
      finishInterruptedRead.countDown()
    }
    firstSocket.closed.await()

    assertEquals(1, firstSocket.closeCount.get())
    assertEquals(0, secondSocket.closeCount.get())
    assertEquals(ConnectionState.Connecting, client.connectionState.replayCache.single())

    client.dispose()
    secondSocket.closed.await()
  }
}
