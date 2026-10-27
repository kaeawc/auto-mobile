package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.daemon.McpStdioClient.DispatchedRequest
import dev.jasonpearson.automobile.desktop.core.daemon.McpStdioClient.PendingResponse
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

internal fun McpStdioClient.callToolWithTimeout(
  name: String,
  arguments: JsonObject,
  deadline: StatusRequestDeadline? = null,
): JsonElement {
  ensureInitialized(deadline)
  val response =
    sendRequest(
      "tools/call",
      buildJsonObject {
        put("name", JsonPrimitive(name))
        put("arguments", arguments)
      },
      deadline = deadline,
    )
  return response.result ?: JsonObject(emptyMap())
}

internal fun McpStdioClient.sendRequest(
  method: String,
  params: JsonElement? = null,
  deadline: StatusRequestDeadline? = null,
): JsonRpcResponse {
  val requestId = JsonPrimitive(UUID.randomUUID().toString())
  val request =
    JsonRpcRequest(
      id = requestId,
      method = method,
      params = params,
    )
  return sendRequest(request, expectResponse = true, deadline = deadline)
}

internal fun McpStdioClient.sendRequest(
  request: JsonRpcRequest,
  expectResponse: Boolean,
  deadline: StatusRequestDeadline? = null,
): JsonRpcResponse {
  val timeoutMs: Long?
  val dispatched: DispatchedRequest
  // The lock covers writing the request only. The wait for the reply happens outside it, so a
  // caller that is cancelled or past its deadline never pins the lock.
  synchronized(ioLock) {
    timeoutMs = deadline?.remainingTimeoutMs()
    dispatched = dispatch(request, expectResponse)
  }
  val pending = dispatched.pending ?: return JsonRpcResponse(jsonrpc = "2.0")
  return awaitReply(request, pending, dispatched.process, timeoutMs)
}

internal fun McpStdioClient.dispatch(
  request: JsonRpcRequest,
  expectResponse: Boolean,
): DispatchedRequest {
  if (reapIfExited()) {
    throw McpConnectionException(
      "MCP stdio server '$command' exited before '${request.method}' was sent; " +
        "the next request starts a new server",
    )
  }
  if (request.method != "initialize" && !initialized) {
    throw serverNotRunning(request.method)
  }
  val currentProcess = process ?: throw serverNotRunning(request.method)
  val currentWriter = writer ?: throw serverNotRunning(request.method)
  val currentPump = pump ?: throw serverNotRunning(request.method)
  val expectedId = request.id?.jsonPrimitive?.content
  val pending =
    if (expectResponse && expectedId != null) PendingResponse(expectedId, currentPump) else null
  try {
    val requestBody = protocolJson.encodeToString(serializer<JsonRpcRequest>(), request)
    currentWriter.write(requestBody)
    currentWriter.newLine()
    currentWriter.flush()
  } catch (e: IOException) {
    // A closed pipe means the child is gone; drop it so the next request starts a new one.
    pending?.abandon()
    retireProcess(currentProcess, unexpected = true)
    terminateProcessTree(currentProcess)
    throw serverExited(request.method, e)
  } catch (e: kotlinx.serialization.SerializationException) {
    pending?.abandon()
    throw e
  }
  return DispatchedRequest(currentProcess, pending)
}

internal fun McpStdioClient.awaitReply(
  request: JsonRpcRequest,
  pending: PendingResponse,
  currentProcess: Process,
  timeoutMs: Long?,
): JsonRpcResponse {
  try {
    val read = Callable { awaitResponse(pending, request.method, timeoutMs) }
    return responseReader.read(read, timeoutMs)
  } catch (_: java.util.concurrent.TimeoutException) {
    pending.abandon()
    // Only a request with a deadline (status probes) restarts the server; the next request
    // starts a fresh process. The old pump stays blocked on the old pipe until it is destroyed.
    discardProcess(currentProcess)
    throw McpConnectionException(
      "MCP stdio request '${request.method}' timed out after ${timeoutMs}ms",
    )
  } catch (e: ExecutionException) {
    rethrowReplyFailure(e, request, pending, currentProcess)
  } catch (e: InterruptedException) {
    // Includes InterruptedException from a cancelled caller: stop waiting for this reply and
    // leave the server running; the late reply is dropped by id.
    pending.abandon()
    throw e
  } catch (e: McpConnectionException) {
    // Includes InterruptedException from a cancelled caller: stop waiting for this reply and
    // leave the server running; the late reply is dropped by id.
    pending.abandon()
    throw e
  } catch (e: kotlinx.coroutines.CancellationException) {
    // Includes InterruptedException from a cancelled caller: stop waiting for this reply and
    // leave the server running; the late reply is dropped by id.
    pending.abandon()
    throw e
  }
}

internal fun McpStdioClient.awaitResponse(
  pending: PendingResponse,
  method: String,
  timeoutMs: Long?,
): JsonRpcResponse {
  val response =
    if (timeoutMs == null) pending.future.get()
    else pending.future.get(timeoutMs, TimeUnit.MILLISECONDS)
  if (response.error != null) {
    throw McpConnectionException(
      "MCP stdio error ${response.error.code}: ${response.error.message}",
    )
  }
  response.resultFor(method)
  return response
}

private fun McpStdioClient.rethrowReplyFailure(
  error: ExecutionException,
  request: JsonRpcRequest,
  pending: PendingResponse,
  currentProcess: Process,
): Nothing {

  dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory.getLogger("McpStdioClient")
    .warn("MCP stdio response failed", error)
  pending.abandon()
  val cause = error.cause
  if (cause is StdioClosedException) {
    // The pipe closed under an in-flight request: the child exited. Its outcome is unknown, so
    // fail it (never replay it); the next request starts a new child.
    synchronized(ioLock) { retireProcess(currentProcess, unexpected = true) }
    terminateProcessTree(currentProcess)
    throw serverExited(request.method, cause)
  }
  throw (cause as? Exception ?: error)
}
