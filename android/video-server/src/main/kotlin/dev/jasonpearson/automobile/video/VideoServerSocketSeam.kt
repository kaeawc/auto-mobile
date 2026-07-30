package dev.jasonpearson.automobile.video

import android.net.LocalServerSocket
import android.net.LocalSocket
import java.io.InputStream
import java.io.OutputStream

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

  override fun close() {
    socket.close()
  }
}
