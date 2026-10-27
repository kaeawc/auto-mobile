package dev.jasonpearson.automobile.junit

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Monotonic time and delay for the heartbeat's bounded authentication/startup replay. */
internal interface HeartbeatRetryClock {
  fun nowNanos(): Long

  fun sleep(ms: Long)
}

internal object SystemHeartbeatRetryClock : HeartbeatRetryClock {
  override fun nowNanos() = System.nanoTime()

  override fun sleep(ms: Long) = Thread.sleep(ms)
}

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
    retryClock: HeartbeatRetryClock = SystemHeartbeatRetryClock,
  ) {
    val started = retryClock.nowNanos()
    val budgetMs =
      DaemonHeartbeat.HEARTBEAT_CONNECT_TIMEOUT_MS + DaemonHeartbeat.HEARTBEAT_READ_TIMEOUT_MS
    val remainingMs = { budgetMs - (retryClock.nowNanos() - started) / 1_000_000 }
    repeat(2) { attempt ->
      val remaining = remainingMs()
      if (remaining <= 0) throw IOException("Daemon heartbeat for $sessionId timed out")
      val retryDelay =
        sendBeat(endpoint, sessionId, livenessOwnerToken, tokenProvider, remaining.toInt())
          ?: return
      if (attempt == 1 || remainingMs() <= retryDelay)
        throw IOException("Daemon heartbeat for $sessionId retry budget exhausted")
      if (retryDelay > 0) retryClock.sleep(retryDelay)
    }
  }

  private fun sendBeat(
    endpoint: URL,
    sessionId: String,
    livenessOwnerToken: String,
    tokenProvider: DaemonHttpTokenProvider,
    remainingMs: Int,
  ): Long? {
    val connection = endpoint.openConnection() as HttpURLConnection
    try {
      connection.instanceFollowRedirects = false
      connection.requestMethod = "POST"
      // This transport creates the connection and owns its headers; the JDK hides Authorization
      // from getRequestProperty, so it cannot be used to detect caller-supplied credentials.
      // The pid-file port is re-resolved per request, only for daemon-shaped URLs.
      val usesDaemonAuthentication =
        daemonHttpPort(endpoint) != null &&
          isDaemonHttpEndpoint(endpoint, tokenProvider.discoveredPort())
      if (usesDaemonAuthentication) {
        tokenProvider.read()?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
      }
      connection.setRequestProperty("Content-Type", "application/json")
      // Split the remaining end-to-end budget across connect and read; never reset it on replay.
      val phaseTimeout = (remainingMs / 2).coerceAtLeast(1)
      connection.connectTimeout = minOf(DaemonHeartbeat.HEARTBEAT_CONNECT_TIMEOUT_MS, phaseTimeout)
      connection.readTimeout = minOf(DaemonHeartbeat.HEARTBEAT_READ_TIMEOUT_MS, phaseTimeout)
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
      val retryDelay = retryDelayMs(connection, status, usesDaemonAuthentication)
      if (retryDelay != null) {
        connection.errorStream?.use { it.readBytes() }
        // Share the existing single-replay budget with authentication refresh.
        return retryDelay
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
      return null
    } finally {
      connection.disconnect()
    }
  }

  private fun retryDelayMs(connection: HttpURLConnection, status: Int, eligible: Boolean): Long? {
    if (!eligible) return null
    if (status == HttpURLConnection.HTTP_UNAUTHORIZED) return 0
    if (
      status == HttpURLConnection.HTTP_UNAVAILABLE &&
        connection.getHeaderField("Retry-After") == "1"
    )
      return 1000
    return null
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

  private fun readDaemonPort(): Int? =
    // The missing port is reported by the caller as a thrown IOException, so no extra log here.
    readDaemonPidPort(
      pidPath = ::daemonPidPath,
      readText = NioDaemonHttpTokenFiles::readPid,
      logUnavailable = {},
    )

  private fun daemonPidPath(): String = userIdResolver.pidPath()
}
