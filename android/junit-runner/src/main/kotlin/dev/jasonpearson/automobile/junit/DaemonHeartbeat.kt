package dev.jasonpearson.automobile.junit

import java.io.Closeable
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal interface DaemonHeartbeatController {
  fun startBackground(intervalMs: Long): Closeable

  fun registerSession(sessionId: String)

  fun unregisterSession(sessionId: String)
}

internal object DaemonHeartbeat {
  private const val DEFAULT_INTERVAL_MS = 1_000L
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

  fun start(sessionId: String, intervalMs: Long = DEFAULT_INTERVAL_MS): Closeable {
    val running = AtomicBoolean(true)
    val heartbeatThread =
      thread(start = true, isDaemon = true, name = "auto-mobile-daemon-heartbeat") {
        while (running.get()) {
          try {
            sendHeartbeat(sessionId)
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
    val endpoint = URL("http://localhost:$port/heartbeat")
    val connection = endpoint.openConnection() as HttpURLConnection
    connection.requestMethod = "POST"
    connection.setRequestProperty("Content-Type", "application/json")
    connection.connectTimeout = 2000
    connection.readTimeout = 2000
    connection.doOutput = true

    val payload =
      json.encodeToString(buildJsonObject { put("sessionId", JsonPrimitive(sessionId)) })
    connection.outputStream.use { it.write(payload.toByteArray()) }

    connection.inputStream.use { it.readBytes() }
    connection.disconnect()
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
