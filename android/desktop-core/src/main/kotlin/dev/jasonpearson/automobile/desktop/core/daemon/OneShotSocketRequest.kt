package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.SocketChannel
import java.nio.charset.StandardCharsets
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Allows applying the appearance mode to every connected device before replying. */
internal const val APPEARANCE_REQUEST_TIMEOUT_MS = 30_000L

/** Allows config updates to evict archived snapshots from disk before replying. */
internal const val DEVICE_SNAPSHOT_REQUEST_TIMEOUT_MS = 30_000L

/** Allows config updates to evict archived recordings from disk before replying. */
internal const val VIDEO_RECORDING_REQUEST_TIMEOUT_MS = 30_000L

/** Allows start to probe a device and stop to assemble its recorded plan. */
internal const val TEST_RECORDING_REQUEST_TIMEOUT_MS = 60_000L

/** Allows start to negotiate WHIP with the remote server before replying. */
internal const val WEBRTC_STREAM_REQUEST_TIMEOUT_MS = 60_000L

/** Allows database-backed poll/ack while freeing the polling thread if it hangs. */
internal const val FAILURES_STREAM_REQUEST_TIMEOUT_MS = 30_000L

internal fun interface SocketRequestCancellation {
  fun cancel()
}

internal interface SocketRequestWatchdog {
  fun arm(timeoutMs: Long, onExpire: () -> Unit): SocketRequestCancellation
}

internal object SharedSocketRequestWatchdog : SocketRequestWatchdog {
  private val executor =
    ScheduledThreadPoolExecutor(1) { runnable ->
        Thread(runnable, "socket-request-watchdog").apply { isDaemon = true }
      }
      .apply { setRemoveOnCancelPolicy(true) }

  override fun arm(timeoutMs: Long, onExpire: () -> Unit): SocketRequestCancellation {
    val task = executor.schedule({ onExpire() }, timeoutMs, TimeUnit.MILLISECONDS)
    return SocketRequestCancellation { task.cancel(false) }
  }
}

/** Bounds connect, write and reading one UTF-8 reply line; parsing remains the caller's concern. */
internal fun oneShotSocketRequest(
  socketPath: String,
  requestLine: String,
  timeoutMs: Long,
  label: String,
  watchdog: SocketRequestWatchdog = SharedSocketRequestWatchdog,
): String {
  require(timeoutMs > 0) { "timeoutMs must be positive" }
  SocketChannel.open(StandardProtocolFamily.UNIX).use { channel ->
    val expired = AtomicBoolean(false)
    // Arm before the blocking connect, including a daemon whose accept backlog is full.
    val deadline =
      watchdog.arm(timeoutMs) {
        expired.set(true)
        try {
          channel.close()
        } catch (_: IOException) {
          // Best-effort watchdog close; use owns the definitive close on the request thread.
        }
      }
    try {
      channel.connect(UnixDomainSocketAddress.of(socketPath))
      return exchangeLine(channel, requestLine, label)
    } catch (error: Exception) {
      if (expired.get()) {
        throw McpConnectionException("$label request timed out after ${timeoutMs}ms", error)
      }
      throw error
    } finally {
      deadline.cancel()
    }
  }
}

private fun exchangeLine(channel: SocketChannel, requestLine: String, label: String): String {
  val reader =
    BufferedReader(InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8))
  val writer =
    BufferedWriter(OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8))
  writer.write(requestLine)
  writer.newLine()
  writer.flush()
  return reader.readLine() ?: throw McpConnectionException("$label socket closed")
}
