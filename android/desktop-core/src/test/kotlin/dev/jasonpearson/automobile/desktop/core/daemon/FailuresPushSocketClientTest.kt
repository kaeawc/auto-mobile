package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.logging.Logger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class FailuresPushSocketClientTest {
  private val options =
    FailuresPushSocketOptions(jitter = { 0.0 }, socketPath = { "fake-failures.sock" })

  @Test
  fun `clean drops record growing delays capped at maximum`() = runTest {
    val expected = listOf(1000L, 2000L, 4000L, 8000L, 16000L, 30000L, 30000L)
    val delays = FakeRetryDelay(expected.size)
    val sockets = mutableListOf<FakeSocket>()
    val client =
      FailuresPushSocketClient(
        { FakeSocket().also { sockets.add(it) } },
        delays,
        backgroundScope,
        { true },
        SilentLogger,
        options,
      )

    client.connect()
    runCurrent()

    assertEquals(expected, delays.calls)
    assertEquals(expected.size, sockets.size)
    assertTrue(sockets.all { it.closed })
    assertEquals(
      ConnectionState.Reconnecting(expected.size, expected.last()),
      client.connectionState.value,
    )
    client.disconnect()
  }

  @Test
  fun `received message resets growing retry counter`() = runTest {
    val delays = FakeRetryDelay(3)
    val sockets =
      ArrayDeque(
        listOf(
          FakeSocket(),
          FakeSocket(),
          FakeSocket(listOf("""{"type":"subscription_response","success":true}""")),
        )
      )
    val client =
      FailuresPushSocketClient(
        { sockets.removeFirst() },
        delays,
        backgroundScope,
        { true },
        SilentLogger,
        options,
      )

    client.connect()
    runCurrent()

    assertEquals(listOf(1000L, 2000L, 1000L), delays.calls)
    assertEquals(ConnectionState.Reconnecting(1, 1000L), client.connectionState.value)
    client.disconnect()
  }

  @Test
  fun `session rejected response preserves Error and stops retries`() = runTest {
    assertRejectionStopsRetries("subscription_response", "session_rejected")
  }

  @Test
  fun `session missing error preserves Error and stops retries`() = runTest {
    assertRejectionStopsRetries("error", "session missing is not an active daemon session")
  }

  private fun TestScope.assertRejectionStopsRetries(
    responseType: String,
    error: String,
  ) {
    val delays = FakeRetryDelay()
    var opens = 0
    val socket = FakeSocket(listOf("""{"type":"$responseType","success":false,"error":"$error"}"""))
    val client =
      FailuresPushSocketClient(
        {
          opens++
          socket
        },
        delays,
        backgroundScope,
        { true },
        SilentLogger,
        options,
      )

    client.connect()
    runCurrent()
    client.connect()
    runCurrent()
    client.disconnect()

    assertEquals(1, opens)
    assertTrue(delays.calls.isEmpty())
    assertTrue(socket.closed)
    assertEquals(ConnectionState.Error(error), client.connectionState.value)
  }

  @Test
  fun `disconnect during retry delay cancels further opens`() = runTest {
    val delays = FakeRetryDelay()
    var opens = 0
    val client =
      FailuresPushSocketClient(
        {
          opens++
          FakeSocket()
        },
        delays,
        backgroundScope,
        { true },
        SilentLogger,
        options,
      )

    client.connect()
    runCurrent()
    assertEquals(ConnectionState.Reconnecting(1, 1000L), client.connectionState.value)
    client.disconnect()
    delays.gate.complete(Unit)
    runCurrent()

    assertEquals(1, opens)
    assertEquals(listOf(1000L), delays.calls)
    assertEquals(ConnectionState.Disconnected(null), client.connectionState.value)
  }

  @Test
  fun `disconnect during socket open closes late socket without subscribing`() = runTest {
    val socket = FakeSocket()
    val delays = FakeRetryDelay()
    var opens = 0
    lateinit var client: FailuresPushSocketClient
    client =
      FailuresPushSocketClient(
        {
          opens++
          client.disconnect()
          socket
        },
        delays,
        backgroundScope,
        { true },
        SilentLogger,
        options,
      )

    client.connect()
    runCurrent()

    assertEquals(1, opens)
    assertTrue(socket.closed)
    assertTrue(socket.writes.isEmpty())
    assertTrue(delays.calls.isEmpty())
    assertEquals(ConnectionState.Disconnected(null), client.connectionState.value)
  }

  @Test
  fun `disconnect after subscription closes socket and stops retries`() = runTest {
    val delays = FakeRetryDelay()
    var opens = 0
    lateinit var client: FailuresPushSocketClient
    val socket =
      FakeSocket(
        onRead = {
          assertTrue(client.isConnected())
          client.disconnect()
        }
      )
    client =
      FailuresPushSocketClient(
        {
          opens++
          socket
        },
        delays,
        backgroundScope,
        { true },
        SilentLogger,
        options,
      )

    client.connect()
    runCurrent()

    assertEquals(1, opens)
    assertTrue(socket.closed)
    assertEquals(listOf("subscribe", "unsubscribe"), socket.writes.map { it.command })
    assertTrue(delays.calls.isEmpty())
    assertFalse(client.isConnected())
    assertEquals(ConnectionState.Disconnected(null), client.connectionState.value)
  }

  @Test
  fun `unavailable socket records growing exception path delays`() = runTest {
    val delays = FakeRetryDelay(3)
    var opens = 0
    val client =
      FailuresPushSocketClient(
        {
          opens++
          FakeSocket()
        },
        delays,
        backgroundScope,
        { false },
        SilentLogger,
        options,
      )

    client.connect()
    runCurrent()

    assertEquals(0, opens)
    assertEquals(listOf(1000L, 2000L, 4000L), delays.calls)
    client.disconnect()
  }

  @Test
  fun `subscribe writes type severity and session UUID`() = runTest {
    val socket = FakeSocket()
    val client =
      FailuresPushSocketClient(
        { socket },
        FakeRetryDelay(),
        backgroundScope,
        { true },
        SilentLogger,
        options.copy(sessionUuidProvider = { "desktop-session" }),
      )

    client.connect(type = "crash", severity = "critical")
    runCurrent()

    val request = socket.writes.single()
    assertEquals("subscribe", request.command)
    assertEquals("crash", request.type)
    assertEquals("critical", request.severity)
    assertEquals("desktop-session", request.sessionUuid)
    assertTrue(request.id.isNotBlank())
    client.disconnect()
  }

  private class FakeRetryDelay(private val stopAfter: Int = 1) : FailuresRetryDelay {
    val calls = mutableListOf<Long>()
    val gate = CompletableDeferred<Unit>()

    override suspend fun wait(delayMs: Long) {
      calls.add(delayMs)
      if (calls.size >= stopAfter) {
        gate.await()
      }
    }
  }

  private class FakeSocket(
    lines: List<String> = emptyList(),
    private val onRead: () -> Unit = {},
  ) : FailuresSocket {
    private val remaining = ArrayDeque(lines)
    val writes = mutableListOf<FailuresPushRequest>()
    var closed = false

    override fun readLine(): String? {
      onRead()
      return remaining.removeFirstOrNull()
    }

    override fun writeLine(line: String) {
      writes.add(DaemonJson.decodeFromString(FailuresPushRequest.serializer(), line))
    }

    override fun close() {
      closed = true
    }
  }

  private object SilentLogger : Logger {
    override fun info(message: String) = Unit

    override fun warn(message: String) = Unit

    override fun warn(message: String, throwable: Throwable) = Unit

    override fun error(message: String) = Unit

    override fun error(message: String, throwable: Throwable) = Unit

    override fun debug(message: String) = Unit
  }
}
