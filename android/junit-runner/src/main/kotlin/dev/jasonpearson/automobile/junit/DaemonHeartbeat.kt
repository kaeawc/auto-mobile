package dev.jasonpearson.automobile.junit

import java.io.Closeable
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

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
) {
  fun describe(): String =
    "the daemon released session $sessionId" +
      (releaseReason?.let { " (releaseReason: $it)" } ?: "") +
      ": $error"
}

internal object DaemonHeartbeat {
  private const val DEFAULT_INTERVAL_MS = 1_000L
  private val HTTP_SUCCESS = 200..299
  private val json = Json { ignoreUnknownKeys = true }
  private val backgroundHeartbeat = BackgroundHeartbeatManager(sendHeartbeat = ::sendHeartbeat)
  private val userIdResolver = DaemonUserIdResolver()
  @JvmStatic internal var testController: DaemonHeartbeatController? = null
  private val defaultController =
    object : DaemonHeartbeatController {
      override fun startBackground(intervalMs: Long): Closeable {
        return backgroundHeartbeat.start(intervalMs)
      }

      override fun registerSession(sessionId: String) {
        backgroundHeartbeat.addSession(sessionId)
      }

      override fun unregisterSession(sessionId: String) {
        backgroundHeartbeat.removeSession(sessionId)
      }

      override fun sessionLoss(sessionId: String): DaemonSessionLoss? =
        backgroundHeartbeat.sessionLoss(sessionId)
    }

  fun startBackground(intervalMs: Long = DEFAULT_INTERVAL_MS): Closeable {
    return controller().startBackground(intervalMs)
  }

  fun registerSession(sessionId: String) {
    controller().registerSession(sessionId)
  }

  fun unregisterSession(sessionId: String) {
    controller().unregisterSession(sessionId)
  }

  /** Why the daemon released [sessionId] while it was heartbeated, or null (#11072). */
  fun sessionLoss(sessionId: String): DaemonSessionLoss? = controller().sessionLoss(sessionId)

  fun start(sessionId: String, intervalMs: Long = DEFAULT_INTERVAL_MS): Closeable {
    val running = AtomicBoolean(true)
    val heartbeatThread =
      thread(start = true, isDaemon = true, name = "auto-mobile-daemon-heartbeat") {
        while (running.get()) {
          try {
            sendHeartbeat(sessionId)
          } catch (_: DaemonSessionReleasedException) {
            // The daemon released the session; heartbeating a dead id forever helps nobody.
            running.set(false)
          } catch (_: Exception) {
            // Best-effort heartbeat; ignore failures
          }

          try {
            Thread.sleep(intervalMs)
          } catch (_: InterruptedException) {
            running.set(false)
          }
        }
      }

    return Closeable {
      running.set(false)
      heartbeatThread.interrupt()
    }
  }

  private fun controller(): DaemonHeartbeatController {
    return testController ?: defaultController
  }

  private fun sendHeartbeat(sessionId: String) {
    val port = readDaemonPort() ?: return
    sendHeartbeat(URL("http://localhost:$port/heartbeat"), sessionId)
  }

  /**
   * POSTs one heartbeat. A 404 means the daemon released the session (#11072), reported as
   * [DaemonSessionReleasedException] with the daemon's `releaseReason`; any other failure throws an
   * ordinary exception the caller treats as a transient miss. The connection is always
   * disconnected.
   */
  internal fun sendHeartbeat(endpoint: URL, sessionId: String) {
    val connection = endpoint.openConnection() as HttpURLConnection
    try {
      connection.requestMethod = "POST"
      connection.setRequestProperty("Content-Type", "application/json")
      connection.connectTimeout = 2000
      connection.readTimeout = 2000
      connection.doOutput = true

      val payload =
        json.encodeToString(buildJsonObject { put("sessionId", JsonPrimitive(sessionId)) })
      connection.outputStream.use { it.write(payload.toByteArray()) }

      val status = connection.responseCode
      if (status == HttpURLConnection.HTTP_NOT_FOUND) {
        val body = connection.errorStream?.use { String(it.readBytes()) }.orEmpty()
        throw sessionReleased(sessionId, body)
      }
      if (status !in HTTP_SUCCESS) {
        connection.errorStream?.use { it.readBytes() }
        throw IOException("Daemon heartbeat for $sessionId failed with HTTP $status")
      }
      connection.inputStream.use { it.readBytes() }
    } finally {
      connection.disconnect()
    }
  }

  private fun sessionReleased(sessionId: String, body: String): DaemonSessionReleasedException {
    val fields =
      try {
        json.parseToJsonElement(body).jsonObject
      } catch (_: Exception) {
        // A non-JSON 404 body still means the session is gone; it just names no reason.
        null
      }
    val error =
      fields?.get("error")?.jsonPrimitive?.contentOrNull ?: "Session not found: $sessionId"
    val releaseReason = fields?.get("releaseReason")?.jsonPrimitive?.contentOrNull
    return DaemonSessionReleasedException(sessionId, releaseReason, error)
  }

  private fun readDaemonPort(): Int? {
    val pidFile = File(daemonPidPath())
    if (!pidFile.exists()) {
      return null
    }

    return try {
      val content = pidFile.readText()
      val element = json.parseToJsonElement(content).jsonObject
      element["port"]?.jsonPrimitive?.intOrNull
    } catch (_: Exception) {
      // A missing or invalid daemon port safely skips this best-effort heartbeat.
      null
    }
  }

  private fun daemonPidPath(): String = userIdResolver.pidPath()
}
