package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.BufferedReader
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.serializer

/**
 * Owns the single blocking read of one MCP stdio child's output pipe and routes each response line
 * to the request that is waiting for its JSON-RPC id (#10142 review).
 *
 * A pipe read cannot be interrupted, so before this class a caller read the pipe itself while
 * holding the client's I/O lock: a stalled server pinned the caller's thread (and every later
 * caller behind the lock) past any timeout or cancellation. Now only this pump's own daemon thread
 * ever blocks on the pipe. A caller waits on an interruptible [CompletableFuture], so a deadline or
 * a cancelled coroutine releases it at once. A request that is abandoned is removed from [pending],
 * so its late reply matches nothing and is dropped instead of reaching the next request.
 *
 * One pump per process; it ends when the pipe closes (child exit, `destroy`), failing everything
 * still waiting.
 */
internal class StdioResponsePump(
  private val reader: BufferedReader,
  private val json: Json,
  private val threadName: String = "mcp-stdio-response-pump",
) {
  private val pending = ConcurrentHashMap<String, CompletableFuture<JsonRpcResponse>>()

  /** Set once the pipe is closed or unreadable; requests registered afterwards fail immediately. */
  @Volatile private var closedWith: McpConnectionException? = null

  fun start() {
    Thread(::pump, threadName).apply { isDaemon = true }.start()
  }

  /** Registers interest in the reply to [requestId]; call before writing the request. */
  fun register(requestId: String): CompletableFuture<JsonRpcResponse> {
    val future = CompletableFuture<JsonRpcResponse>()
    pending[requestId] = future
    // The pump publishes closedWith before draining, so either it sees this entry or we see it.
    closedWith?.let { future.completeExceptionally(it) }
    return future
  }

  /** Stops waiting for [requestId]; its reply, if it ever arrives, is discarded. */
  fun abandon(requestId: String) {
    pending.remove(requestId)
  }

  private fun pump() {
    val failure =
      try {
        readUntilClosed()
        McpConnectionException("MCP stdio closed")
      } catch (e: Exception) {
        // A closed or broken pipe (child exit, client destroy) or an unexpected reader fault ends
        // the pump; every waiter receives it as a typed failure instead of hanging.
        McpConnectionException("MCP stdio closed: ${e.message}", e)
      }
    closedWith = failure
    pending.values.forEach { it.completeExceptionally(failure) }
    pending.clear()
  }

  private fun readUntilClosed() {
    while (true) {
      val line = reader.readLine() ?: return
      if (line.isNotBlank()) {
        dispatch(line)
      }
    }
  }

  private fun dispatch(line: String) {
    val response =
      try {
        json.decodeFromString(serializer<JsonRpcResponse>(), line)
      } catch (e: kotlinx.serialization.SerializationException) {
        failAll(McpConnectionException("MCP stdio sent an unreadable response: ${e.message}", e))
        return
      }
    // Server notifications carry no id; replies for abandoned requests match nothing. Both drop.
    val id = (response.id as? JsonPrimitive)?.content ?: return
    pending.remove(id)?.complete(response)
  }

  private fun failAll(failure: McpConnectionException) {
    val waiting = pending.keys.toList()
    waiting.forEach { pending.remove(it)?.completeExceptionally(failure) }
  }
}
