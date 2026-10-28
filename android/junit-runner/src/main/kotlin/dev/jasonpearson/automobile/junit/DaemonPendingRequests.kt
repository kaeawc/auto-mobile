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

internal interface DaemonRequestClock {
  fun nowMs(): Long

  fun await(future: CompletableFuture<DaemonResponse>, timeoutMs: Long): DaemonResponse
}

internal object SystemDaemonRequestClock : DaemonRequestClock {
  override fun nowMs(): Long = TimeUnit.NANOSECONDS.toMillis(System.nanoTime())

  override fun await(future: CompletableFuture<DaemonResponse>, timeoutMs: Long): DaemonResponse =
    future.get(timeoutMs, TimeUnit.MILLISECONDS)
}

/** Correlates pending requests and serializes socket writes; read-side completion is concurrent. */
internal class DaemonPendingRequests(
  private val writer: BufferedWriter,
  private val clock: DaemonRequestClock = SystemDaemonRequestClock,
) {
  private class PendingRequest(val sentAtMs: Long, @Volatile var budgetMs: Long) {
    val future = CompletableFuture<DaemonResponse>()
  }

  private val json = Json { ignoreUnknownKeys = true }
  private val pending = ConcurrentHashMap<String, PendingRequest>()
  private val writeLock = Any()
  val size: Int
    get() = pending.size

  fun execute(request: DaemonRequest, timeoutMs: Long): DaemonResponse {
    val entry = PendingRequest(clock.nowMs(), timeoutMs)
    pending[request.id] = entry
    try {
      sendRequest(request)
      return awaitResponse(entry)
    } catch (e: IOException) {
      throw DaemonSocketClient.mapAwaitFailure(e, entry.budgetMs)
    } finally {
      pending.remove(request.id, entry)
    }
  }

  fun adoptBudget(requestId: String, timeoutMs: Long) {
    if (timeoutMs <= 0) return
    val entry = pending[requestId] ?: return
    if (entry.budgetMs != timeoutMs) entry.budgetMs = timeoutMs
  }

  private fun awaitResponse(entry: PendingRequest): DaemonResponse {
    try {
      while (true) {
        val deadlineMs = entry.sentAtMs + entry.budgetMs + RESPONSE_GRACE_MS
        val remainingMs = deadlineMs - clock.nowMs()
        if (remainingMs <= 0) throw TimeoutException()
        try {
          return clock.await(entry.future, minOf(remainingMs, BUDGET_CHECK_INTERVAL_MS))
        } catch (_: TimeoutException) {
          // A slice expired; re-read the budget announced concurrently by the socket reader.
        }
      }
    } catch (e: TimeoutException) {
      throw DaemonSocketClient.mapAwaitFailure(e, entry.budgetMs)
    } catch (e: ExecutionException) {
      throw DaemonSocketClient.mapAwaitFailure(e, entry.budgetMs)
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
      throw DaemonSocketClient.mapAwaitFailure(e, entry.budgetMs)
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
    pending.remove(response.id)?.future?.complete(response)
  }

  fun failPendingRequests(message: String) {
    val exception = DaemonUnavailableException(message)
    pending.values.forEach { entry -> entry.future.completeExceptionally(exception) }
    pending.clear()
  }

  private companion object {
    // Keep in sync with DAEMON_RESPONSE_GRACE_MS in src/daemon/client/client.ts.
    const val RESPONSE_GRACE_MS = 2000L
    const val BUDGET_CHECK_INTERVAL_MS = 100L
  }
}
