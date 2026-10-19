package dev.jasonpearson.automobile.junit

import java.io.Closeable
import java.net.HttpURLConnection
import java.net.URL

internal interface DaemonHeartbeatController {
  fun startBackground(intervalMs: Long): Closeable

  fun registerSession(sessionId: String)

  fun unregisterSession(sessionId: String)

  /**
   * Why the daemon released [sessionId] while it was heartbeated, or null if it has not (#11072).
   */
  fun sessionLoss(sessionId: String): DaemonSessionLoss? = null
}

/**
 * The daemon answered a heartbeat with 404: it released this session (or never issued it), so the
 * runner no longer holds its device (#11072). [releaseReason] is the daemon's `releaseReason`
 * (`idle`, `heartbeat-timeout`, `daemon-shutdown`, ...), absent from older daemons.
 */
internal class DaemonSessionReleasedException(
  val sessionId: String,
  val releaseReason: String?,
  message: String,
) : RuntimeException(message)

/** A session the daemon released while the runner still heartbeated it (#11072). */
internal data class DaemonSessionLoss(
  val sessionId: String,
  val releaseReason: String?,
  val error: String,
  /** False when no heartbeat for the id ever succeeded and the daemon named no reason. */
  val confirmed: Boolean = true,
) {
  fun describe(): String =
    "the daemon released session $sessionId" +
      (releaseReason?.let { " (releaseReason: $it)" } ?: "") +
      ": $error"
}

internal object DaemonHeartbeat : DaemonHeartbeatController {
  internal const val DEFAULT_INTERVAL_MS = 1_000L

  /**
   * Connect and read timeouts for one beat. A hung beat blocks its session's next beat (in-flight
   * skip), so the worst gap between beats reaching the daemon is roughly the interval plus both
   * timeouts; at 1 s each (iOS parity) that stays under the daemon's 4 s lease (#11208).
   */
  internal const val HEARTBEAT_CONNECT_TIMEOUT_MS = 1_000
  internal const val HEARTBEAT_READ_TIMEOUT_MS = 1_000

  internal fun applyBeatTimeouts(connection: HttpURLConnection) {
    connection.connectTimeout = HEARTBEAT_CONNECT_TIMEOUT_MS
    connection.readTimeout = HEARTBEAT_READ_TIMEOUT_MS
  }

  /** Worst-case gap between two beats reaching the daemon when one beat hangs to its timeouts. */
  internal fun worstCaseBeatGapMs(intervalMs: Long = DEFAULT_INTERVAL_MS): Long =
    intervalMs + HEARTBEAT_CONNECT_TIMEOUT_MS + HEARTBEAT_READ_TIMEOUT_MS

  private val backgroundHeartbeat =
    BackgroundHeartbeatManager(sendHeartbeat = HeartbeatTransport::sendHeartbeat)

  fun startBackground(): Closeable = startBackground(DEFAULT_INTERVAL_MS)

  override fun startBackground(intervalMs: Long): Closeable = backgroundHeartbeat.start(intervalMs)

  override fun registerSession(sessionId: String) = backgroundHeartbeat.addSession(sessionId)

  override fun unregisterSession(sessionId: String) = backgroundHeartbeat.removeSession(sessionId)

  /** Why the daemon released [sessionId] while it was heartbeated, or null (#11072). */
  override fun sessionLoss(sessionId: String): DaemonSessionLoss? =
    backgroundHeartbeat.sessionLoss(sessionId)

  internal fun sendHeartbeat(
    endpoint: URL,
    sessionId: String,
    livenessOwnerToken: String = DaemonLivenessOwner.token,
  ) = HeartbeatTransport.sendHeartbeat(endpoint, sessionId, livenessOwnerToken)
}
