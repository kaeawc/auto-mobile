package dev.jasonpearson.automobile.desktop.core.daemon

import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Owns the daemon session used by one desktop app run against one Unix-socket daemon.
 *
 * The UUID is deliberately stable for the lifetime of the holder. Main-socket tool calls and the
 * separate stream sockets therefore authenticate as the same owner. Releasing is idempotent so a
 * Compose disposal and an explicit process swap cannot double-release the daemon session.
 */
class DesktopDaemonSession(val client: McpDaemonClient) : AutoCloseable {

  val sessionUuid: String =
    requireNotNull(client.sessionUuid) { "DesktopDaemonSession requires a session-bound client" }

  private val released = AtomicBoolean(false)

  /** Provider passed to stream clients; released sessions fail closed by omitting the UUID. */
  val sessionUuidProvider: () -> String?
    get() = { sessionUuid.takeUnless { released.get() } }

  fun release() {
    if (released.compareAndSet(false, true)) {
      client.releaseSession()
    }
  }

  fun heartbeat() {
    if (!released.get()) {
      client.heartbeatSession()
    }
  }

  override fun close() = release()

  companion object {
    fun create(socketPath: String = DaemonSocketPaths.socketPath()): DesktopDaemonSession {
      val sessionUuid = UUID.randomUUID().toString()
      return DesktopDaemonSession(
        McpDaemonClient(socketPathValue = socketPath, sessionUuid = sessionUuid)
      )
    }
  }
}
