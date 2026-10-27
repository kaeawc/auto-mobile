package dev.jasonpearson.automobile.desktop.core.telemetry

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.io.IOException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/** Interface for executing network requests. Enables testing with fakes. */
interface NetworkRequestExecutor {
  fun run(
    url: String,
    method: String,
    requestHeaders: Map<String, String>?,
    requestBody: String?,
  ): NetworkReplayResult
}

/** Result of replaying a network request from the IDE. */
data class NetworkReplayResult(
  val statusCode: Int,
  val durationMs: Long,
  val responseHeaders: Map<String, String>,
  val responseBody: String?,
  val responseBodyBytes: ByteArray? = null,
  val error: String?,
)

/** Replays a network request using the JVM HttpClient. */
object NetworkRequestRunner : NetworkRequestExecutor {

  private val client =
    HttpClient.newBuilder()
      .followRedirects(HttpClient.Redirect.NORMAL)
      .connectTimeout(Duration.ofSeconds(30))
      .build()

  override fun run(
    url: String,
    method: String,
    requestHeaders: Map<String, String>?,
    requestBody: String?,
  ): NetworkReplayResult {
    val startMs = System.currentTimeMillis()
    return try {
      val request = buildRequest(url, method, requestHeaders, requestBody)
      val response = client.send(request, HttpResponse.BodyHandlers.ofByteArray())
      replayResult(response, System.currentTimeMillis() - startMs)
    } catch (e: IOException) {
      failedReplay(e, startMs)
    } catch (e: InterruptedException) {
      failedReplay(e, startMs)
    } catch (e: IllegalArgumentException) {
      failedReplay(e, startMs)
    } catch (e: SecurityException) {
      failedReplay(e, startMs)
    }
  }

  private fun buildRequest(
    url: String,
    method: String,
    requestHeaders: Map<String, String>?,
    requestBody: String?,
  ): HttpRequest {
    val builder = HttpRequest.newBuilder().uri(URI.create(url)).timeout(Duration.ofSeconds(30))
    requestHeaders?.forEach { (key, value) ->
      val managedHeader =
        key.equals("Host", ignoreCase = true) || key.equals("Content-Length", ignoreCase = true)
      if (!managedHeader) builder.header(key, value)
    }
    val body =
      requestBody?.let { HttpRequest.BodyPublishers.ofString(it) }
        ?: HttpRequest.BodyPublishers.noBody()
    when (val upperMethod = method.uppercase()) {
      "GET" -> builder.GET()
      "DELETE" -> builder.DELETE()
      "POST",
      "PUT",
      "PATCH" -> builder.method(upperMethod, body)
      "HEAD",
      "OPTIONS" -> builder.method(upperMethod, HttpRequest.BodyPublishers.noBody())
      else -> builder.method(method, body)
    }
    return builder.build()
  }

  private fun replayResult(
    response: HttpResponse<ByteArray>,
    durationMs: Long,
  ): NetworkReplayResult {
    val respHeaders = mutableMapOf<String, String>()
    response.headers().map().forEach { (key, values) ->
      if (key != null) {
        respHeaders[key] = values.joinToString(", ")
      }
    }

    val bodyBytes = response.body()
    val contentType =
      respHeaders.entries.find { it.key.equals("content-type", ignoreCase = true) }?.value ?: ""
    val isBinary =
      contentType.startsWith("image/") ||
        contentType.startsWith("audio/") ||
        contentType.startsWith("video/") ||
        contentType.contains("octet-stream")
    val bodyStr = if (isBinary) null else String(bodyBytes, Charsets.UTF_8)

    return NetworkReplayResult(
      statusCode = response.statusCode(),
      durationMs = durationMs,
      responseHeaders = respHeaders,
      responseBody = bodyStr,
      responseBodyBytes = if (isBinary) bodyBytes else null,
      error = null,
    )
  }

  private fun failedReplay(error: Exception, startMs: Long): NetworkReplayResult {
    val durationMs = System.currentTimeMillis() - startMs
    LoggerFactory.getLogger("NetworkRequestRunner").warn("Failed to replay network request", error)
    return NetworkReplayResult(
      statusCode = 0,
      durationMs = durationMs,
      responseHeaders = emptyMap(),
      responseBody = null,
      error = error.message ?: error.javaClass.simpleName,
    )
  }
}
