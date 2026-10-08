package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.ServerSocketChannel
import java.nio.channels.SocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private const val SOCKET_TEST_BOUND_SECONDS = 2L

/** A temp-dir peer that reads one request and holds it until close, or sends a raw test reply. */
internal class HungSocketServer(
  private val replyLine: String? = null,
  private val closeWithoutReply: Boolean = false,
) : AutoCloseable {
  private val tempDir = Files.createTempDirectory(Path.of("/tmp"), "amsock-")
  val socketPath: Path = tempDir.resolve("test.sock")
  private val server =
    ServerSocketChannel.open(StandardProtocolFamily.UNIX)
      .bind(UnixDomainSocketAddress.of(socketPath))
  private val received = CountDownLatch(1)
  private val release = CountDownLatch(1)
  private val closed = AtomicBoolean(false)
  private val accepted = AtomicReference<SocketChannel?>()
  private val task = FutureTask<Unit> { serve() }
  private val thread =
    Thread(task, "one-shot-test-server").apply {
      isDaemon = true
      start()
    }

  private fun serve() {
    try {
      server.accept().use { channel ->
        accepted.set(channel)
        if (closed.get()) return
        val reader =
          BufferedReader(
            InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8),
          )
        checkNotNull(reader.readLine()) { "Client closed before sending its request" }
        received.countDown()
        if (closeWithoutReply) return
        if (replyLine == null) {
          release.await()
        } else {
          val writer =
            BufferedWriter(
              OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8),
            )
          writer.write(replyLine)
          writer.newLine()
          writer.flush()
        }
      }
    } catch (error: IOException) {
      if (!closed.get()) throw AssertionError("Test socket server failed", error)
      // Closing the fixture deliberately interrupts accept/read and releases a hung peer.
    }
  }

  fun awaitRequest() {
    assertTrue(received.await(SOCKET_TEST_BOUND_SECONDS, TimeUnit.SECONDS), "Request never arrived")
  }

  override fun close() {
    closed.set(true)
    release.countDown()
    server.close()
    accepted.get()?.close()
    try {
      task.get(SOCKET_TEST_BOUND_SECONDS, TimeUnit.SECONDS)
    } finally {
      thread.join(TimeUnit.SECONDS.toMillis(SOCKET_TEST_BOUND_SECONDS))
      Files.deleteIfExists(socketPath)
      Files.deleteIfExists(tempDir)
    }
    assertFalse(thread.isAlive, "Server thread did not stop")
  }
}

/** Runs blocking client work with a regression bound and interrupts only its owned thread. */
internal class SocketRequestTask<T>(request: () -> T) : AutoCloseable {
  private val task = FutureTask<T> { request() }
  private val thread =
    Thread(task, "one-shot-test-client").apply {
      isDaemon = true
      start()
    }

  fun result(): T =
    try {
      task.get(SOCKET_TEST_BOUND_SECONDS, TimeUnit.SECONDS)
    } catch (error: ExecutionException) {
      throw (error.cause ?: error)
    }

  override fun close() {
    task.cancel(true)
    thread.join(TimeUnit.SECONDS.toMillis(SOCKET_TEST_BOUND_SECONDS))
    assertFalse(thread.isAlive, "Client thread did not stop")
  }
}

internal class FakeSocketRequestWatchdog(private val expireOnCancel: Boolean = false) :
  SocketRequestWatchdog {
  private val armed = CountDownLatch(1)
  private var expire: (() -> Unit)? = null
  private val cancelled = AtomicBoolean(false)
  private val arms = AtomicInteger()
  private val cancellations = AtomicInteger()
  var timeoutMs: Long? = null
    private set

  override fun arm(timeoutMs: Long, onExpire: () -> Unit): SocketRequestCancellation {
    this.timeoutMs = timeoutMs
    expire = onExpire
    arms.incrementAndGet()
    armed.countDown()
    return SocketRequestCancellation {
      cancellations.incrementAndGet()
      // Model a scheduler task already running as cancellation races a fully read reply.
      if (expireOnCancel) onExpire()
      cancelled.set(true)
    }
  }

  fun fire() {
    assertTrue(armed.await(SOCKET_TEST_BOUND_SECONDS, TimeUnit.SECONDS), "Watchdog was not armed")
    if (!cancelled.get()) checkNotNull(expire).invoke()
  }

  fun assertCancelled(expectedTimeoutMs: Long) {
    assertEquals(expectedTimeoutMs, timeoutMs)
    assertEquals(1, arms.get())
    assertEquals(1, cancellations.get())
    assertTrue(cancelled.get(), "Watchdog task remains scheduled")
  }
}
