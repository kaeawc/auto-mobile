package dev.jasonpearson.automobile.junit

import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal object HeartbeatTransport {
  private val HTTP_SUCCESS = 200..299
  private val json = Json { ignoreUnknownKeys = true }
  private val userIdResolver = DaemonUserIdResolver()
  private val tokenProvider: DaemonHttpTokenProvider = FileDaemonHttpTokenProvider()

  fun sendHeartbeat(sessionId: String) {
    // A missing port is a miss, not an acknowledgement: it must not confirm the session.
    val port = readDaemonPort() ?: throw IOException("Daemon port unavailable")
    sendHeartbeat(URL("http://localhost:$port/heartbeat"), sessionId)
  }

  /**
   * POSTs one heartbeat. A 404 means the daemon released the session (#11072), reported as
   * [DaemonSessionReleasedException] with the daemon's `releaseReason`; any other failure throws an
   * ordinary exception the caller treats as a transient miss and warns about, rate-limited. The
   * connection is always disconnected.
   */
  internal fun sendHeartbeat(
    endpoint: URL,
    sessionId: String,
    livenessOwnerToken: String = DaemonLivenessOwner.token,
    tokenProvider: DaemonHttpTokenProvider = this.tokenProvider,
  ) {
    if (
      sendBeat(endpoint, sessionId, livenessOwnerToken, tokenProvider, retryAuthentication = true)
    ) {
      sendBeat(endpoint, sessionId, livenessOwnerToken, tokenProvider, retryAuthentication = false)
    }
  }

  private fun sendBeat(
    endpoint: URL,
    sessionId: String,
    livenessOwnerToken: String,
    tokenProvider: DaemonHttpTokenProvider,
    retryAuthentication: Boolean,
  ): Boolean {
    val connection = endpoint.openConnection() as HttpURLConnection
    try {
      connection.instanceFollowRedirects = false
      connection.requestMethod = "POST"
      tokenProvider.read()?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
      connection.setRequestProperty("Content-Type", "application/json")
      DaemonHeartbeat.applyBeatTimeouts(connection)
      connection.doOutput = true

      val payload =
        json.encodeToString(
          buildJsonObject {
            put("sessionId", JsonPrimitive(sessionId))
            put("livenessOwnerToken", JsonPrimitive(livenessOwnerToken))
          },
        )
      connection.outputStream.use { it.write(payload.toByteArray()) }

      val status = connection.responseCode
      if (status == HttpURLConnection.HTTP_UNAUTHORIZED && retryAuthentication) {
        connection.errorStream?.use { it.readBytes() }
        return true
      }
      if (status == HttpURLConnection.HTTP_NOT_FOUND) {
        val body = connection.errorStream?.use { String(it.readBytes()) }.orEmpty()
        throw sessionReleased(sessionId, body)
      }
      if (status !in HTTP_SUCCESS) {
        connection.errorStream?.use { it.readBytes() }
        throw IOException("Daemon heartbeat for $sessionId failed with HTTP $status")
      }
      connection.inputStream.use { it.readBytes() }
      return false
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
