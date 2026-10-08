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
class DesktopDaemonSession(
  val client: McpDaemonClient,
  private val registration: DesktopSessionRegistration =
    DesktopSessionRegistration(
      register = {
        check(
          client.registerSession(requireNotNull(client.sessionUuid), "AutoMobile Desktop").accepted,
        ) {
          "Daemon rejected desktop session registration"
        }
      },
      heartbeat = { client.heartbeatSession() },
    ),
) : AutoCloseable {

  val sessionUuid: String =
    requireNotNull(client.sessionUuid) { "DesktopDaemonSession requires a session-bound client" }

  private val released = AtomicBoolean(false)

  /** Provider passed to stream clients; released sessions fail closed by omitting the UUID. */
  val sessionUuidProvider: () -> String? = {
    sessionUuid.takeIf { registration.isRegistered.value && !released.get() }
  }

  val isRegistered = registration.isRegistered

  fun ensureRegistered() {
    check(!released.get()) { "Desktop session has been released" }
    registration.ensureRegistered()
  }

  fun deviceBound(held: Boolean = true) = registration.deviceBound(held)

  /** Whether the daemon holds a device for this session that a release would free (#10659). */
  val holdsDevice: Boolean
    get() = registration.holdsDevice

  fun release() {
    if (released.compareAndSet(false, true)) {
      registration.clear()
      client.releaseSession()
    }
  }

  fun heartbeat() {
    if (!released.get()) {
      registration.heartbeat()
    }
  }

  override fun close() = release()

  companion object {
    fun create(socketPath: String = DaemonSocketPaths.socketPath()): DesktopDaemonSession {
      val sessionUuid = UUID.randomUUID().toString()
      return DesktopDaemonSession(
        McpDaemonClient(socketPathValue = socketPath, sessionUuid = sessionUuid),
      )
    }
  }
}
