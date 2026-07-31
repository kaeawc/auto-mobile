package dev.jasonpearson.automobile.video

import android.net.LocalServerSocket
import android.net.LocalSocket
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.SocketTimeoutException

/**
 * Narrow seam over `android.net.LocalServerSocket` / `android.net.LocalSocket` so
 * [VideoStreamWriter]'s accept / write / replay / command paths can be driven by fakes.
 *
 * The framework socket classes are only available inside `app_process`, so the concrete
 * [LocalServerSocketAdapter] / [LocalSocketConnection] wrappers below are never loaded in a plain
 * JVM unit test; tests inject their own [VideoServerSocketFactory] instead. This mirrors how
 * `DisplayControl` wraps hidden framework display APIs behind a testable surface.
 */
fun interface VideoServerSocketFactory {
  /** Bind an abstract local socket named [socketName] and return the listening server socket. */
  fun create(socketName: String): VideoServerSocket
}

/** A bound, listening server socket. */
interface VideoServerSocket {
  /**
   * Block until a client connects and return it, or `null` when there are no further clients and
   * the acceptor loop should stop. Throws [java.io.IOException] when the socket is closed or the
   * accept fails.
   */
  fun accept(): VideoClientConnection?

  /** Close the listening socket, unblocking a pending [accept]. */
  fun close()
}

/** A single bidirectional client connection exposing only the byte streams the writer needs. */
interface VideoClientConnection {
  val outputStream: OutputStream
  val inputStream: InputStream

  /**
   * The connecting peer's OS-level process UID, read from `SO_PEERCRED`
   * (`LocalSocket.getPeerCredentials().getUid()`). Abstract-namespace local sockets carry no
   * filesystem ACL, so this kernel-supplied credential is the only trustworthy peer identity the
   * writer can gate on before emitting any stream bytes (issue #4728).
   */
  val peerUid: Int

  /**
   * Read exactly [count] bytes from the peer into a fresh array within [timeoutMs] total elapsed
   * time, returning `null` on timeout, EOF, or I/O error. This is the only inbound-read capability
   * the writer needs before the stream starts: it reads the pre-stream token handshake
   * (issue #4729) with a bounded deadline so a silent connector cannot hold the accept slot open.
   * Kept on the seam (rather than exposing raw blocking-read + `SO_TIMEOUT` plumbing) so the
   * handshake is driven by fakes in unit tests. The command-channel reader continues to use
   * [inputStream] directly once the stream is live.
   */
  fun readFully(count: Int, timeoutMs: Long): ByteArray?

  fun close()
}

/** Production factory that binds a real abstract-namespace `LocalServerSocket`. */
internal object LocalServerSocketFactory : VideoServerSocketFactory {
  override fun create(socketName: String): VideoServerSocket =
    LocalServerSocketAdapter(LocalServerSocket(socketName))
}

internal class LocalServerSocketAdapter(private val serverSocket: LocalServerSocket) :
  VideoServerSocket {
  override fun accept(): VideoClientConnection = LocalSocketConnection(serverSocket.accept())

  override fun close() {
    serverSocket.close()
  }
}

internal class LocalSocketConnection(private val socket: LocalSocket) : VideoClientConnection {
  override val outputStream: OutputStream
    get() = socket.outputStream

  override val inputStream: InputStream
    get() = socket.inputStream

  override val peerUid: Int
    get() = socket.peerCredentials.uid

  /**
   * Bounded, total-deadline blocking read of exactly [count] bytes. `SO_TIMEOUT` bounds each
   * individual blocking read; the deadline loop re-arms it to the remaining budget so the whole
   * read can never exceed [timeoutMs], even across a partial-read boundary. Returns `null` on
   * timeout, EOF (a peer that connected but sent a short/absent handshake), or any I/O error — the
   * caller treats every `null` as a rejected handshake and closes without emitting stream bytes.
   */
  override fun readFully(count: Int, timeoutMs: Long): ByteArray? {
    if (count <= 0) return ByteArray(0)
    val deadline = System.nanoTime() + timeoutMs * 1_000_000L
    val buffer = ByteArray(count)
    var read = 0
    val input = socket.inputStream
    val previousTimeout = socket.soTimeout
    try {
      while (read < count) {
        val remainingMs = (deadline - System.nanoTime()) / 1_000_000L
        if (remainingMs <= 0) return null
        socket.soTimeout = remainingMs.coerceAtMost(Int.MAX_VALUE.toLong()).toInt().coerceAtLeast(1)
        val n =
          try {
            input.read(buffer, read, count - read)
          } catch (_: SocketTimeoutException) {
            return null
          }
        if (n < 0) return null
        read += n
      }
      return buffer
    } catch (_: IOException) {
      return null
    } finally {
      try {
        socket.soTimeout = previousTimeout
      } catch (_: IOException) {
        // Restoring the prior timeout is best-effort; the connection is about to stream or close.
      }
    }
  }

  override fun close() {
    socket.close()
  }
}
