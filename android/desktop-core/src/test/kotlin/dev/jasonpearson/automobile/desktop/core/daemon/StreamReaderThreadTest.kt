package dev.jasonpearson.automobile.desktop.core.daemon

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamReaderThreadTest {
  private class CountingReaderThreads : StreamReaderDispatcherFactory {
    val created = CopyOnWriteArrayList<ExecutorCoroutineDispatcher>()

    override fun create(name: String): ExecutorCoroutineDispatcher =
      DedicatedStreamReaderThreads.create(name).also { created.add(it) }
  }

  private class RecordingSocket : TelemetrySocket {
    val readThread = CompletableDeferred<Thread>()

    override fun readLine(): String? {
      readThread.complete(Thread.currentThread())
      return null
    }

    override fun writeLine(line: String) = Unit

    override fun close() = Unit
  }

  @Test
  fun `telemetry reads park on a dedicated daemon thread, not the shared IO pool`() = runTest {
    val threads = CountingReaderThreads()
    val socket = RecordingSocket()
    val client =
      TelemetryPushSocketClient(
        { socket },
        {},
        backgroundScope,
        { true },
        options = TelemetryPushSocketOptions(readerThreads = threads),
      )

    client.connect()
    val reader = socket.readThread.await()

    assertTrue(reader.name, reader.name.startsWith("telemetry-push-reader"))
    assertTrue(reader.isDaemon)
    assertEquals(1, threads.created.size)
    client.dispose()
  }

  @Test
  fun `each connection gets its own reader thread, released when the read ends`() = runTest {
    val threads = CountingReaderThreads()
    val first = RecordingSocket()
    val second = RecordingSocket()
    val sockets = ArrayDeque(listOf(first, second))
    val client =
      TelemetryPushSocketClient(
        { sockets.removeFirstOrNull() ?: RecordingSocket() },
        {},
        backgroundScope,
        { true },
        options = TelemetryPushSocketOptions(readerThreads = threads),
      )

    client.connect()
    val firstReader = first.readThread.await()
    val secondReader = second.readThread.await()

    assertTrue(firstReader !== secondReader)
    assertTrue(threads.created.size >= 2)
    val firstExecutor = threads.created.first().executor as java.util.concurrent.ExecutorService
    assertTrue(firstExecutor.isShutdown)
    client.dispose()
  }
}
