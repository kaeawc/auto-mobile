package dev.jasonpearson.automobile.junit

import java.io.BufferedWriter
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Correlates pending requests and serializes socket writes; read-side completion is concurrent. */
internal class DaemonPendingRequests(private val writer: BufferedWriter) {
  private val json = Json { ignoreUnknownKeys = true }
  private val pending = ConcurrentHashMap<String, CompletableFuture<DaemonResponse>>()
  private val writeLock = Any()
  val size: Int
    get() = pending.size

  fun execute(request: DaemonRequest, timeoutMs: Long): DaemonResponse {
    val responseFuture = CompletableFuture<DaemonResponse>()
    registerAndSend(request.id, responseFuture, request, timeoutMs)
    return awaitResponse(request.id, responseFuture, timeoutMs)
  }

  private fun awaitResponse(
    requestId: String,
    responseFuture: CompletableFuture<DaemonResponse>,
    timeoutMs: Long,
  ): DaemonResponse {
    return try {
      responseFuture.get(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (e: TimeoutException) {
      throw DaemonSocketClient.mapAwaitFailure(e, timeoutMs)
    } catch (e: ExecutionException) {
      throw DaemonSocketClient.mapAwaitFailure(e, timeoutMs)
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
      throw DaemonSocketClient.mapAwaitFailure(e, timeoutMs)
    } finally {
      pending.remove(requestId)
    }
  }

  private fun registerAndSend(
    requestId: String,
    responseFuture: CompletableFuture<DaemonResponse>,
    request: DaemonRequest,
    timeoutMs: Long,
  ) {
    pending[requestId] = responseFuture
    try {
      sendRequest(request)
    } catch (e: IOException) {
      pending.remove(requestId)
      throw DaemonSocketClient.mapAwaitFailure(e, timeoutMs)
    }
  }

  private fun sendRequest(request: DaemonRequest) {
    val payload = json.encodeToString(request)
    synchronized(writeLock) {
      writer.write(payload)
      writer.newLine()
      writer.flush()
    }
  }

  fun handleResponse(response: DaemonResponse) {
    val future = pending.remove(response.id)
    if (future != null) {
      future.complete(response)
    }
  }

  fun failPendingRequests(message: String) {
    val exception = DaemonUnavailableException(message)
    pending.values.forEach { future -> future.completeExceptionally(exception) }
    pending.clear()
  }
}
