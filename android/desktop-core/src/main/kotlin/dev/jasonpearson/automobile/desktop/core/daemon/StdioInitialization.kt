package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.daemon.McpStdioClient.InitializationClaim
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject

internal fun McpStdioClient.ensureInitialized(deadline: StatusRequestDeadline? = null) {
  val claim = claimInitialization(deadline) ?: return
  if (claim.leader) {
    initializeAsLeader(claim.flight, deadline)
  } else {
    awaitLeader(claim.flight, deadline)
  }
}

internal fun McpStdioClient.claimInitialization(
  deadline: StatusRequestDeadline?,
): InitializationClaim? =
  synchronized(ioLock) {
    deadline?.remainingTimeoutMs()
    reapIfExited()
    val inProgress = initialization
    when {
      inProgress != null -> InitializationClaim(inProgress, leader = false)
      initialized -> null
      else -> {
        assertRestartAllowed()
        startProcess()
        val flight = CompletableFuture<Unit>()
        initialization = flight
        InitializationClaim(flight, leader = true)
      }
    }
  }

internal fun McpStdioClient.initializeAsLeader(
  flight: CompletableFuture<Unit>,
  deadline: StatusRequestDeadline?,
) {
  try {
    val response =
      sendRequest(
        "initialize",
        buildInitializeParams(),
        deadline = deadline,
      )
    val result =
      response.result?.jsonObject
        ?: throw McpConnectionException("Initialize response missing result")
    negotiateProtocolVersion(result)
    synchronized(ioLock) {
      if (process == null) {
        throw serverNotRunning("initialize")
      }
      initialized = true
    }
    sendNotification("notifications/initialized", deadline = deadline)
    flight.complete(Unit)
  } catch (e: IOException) {
    flight.completeExceptionally(e)
    throw e
  } catch (e: McpConnectionException) {
    flight.completeExceptionally(e)
    throw e
  } catch (e: kotlinx.serialization.SerializationException) {
    flight.completeExceptionally(e)
    throw e
  } catch (e: InterruptedException) {
    flight.completeExceptionally(e)
    throw e
  } catch (e: kotlinx.coroutines.CancellationException) {
    flight.completeExceptionally(e)
    throw e
  } finally {
    synchronized(ioLock) {
      if (initialization === flight) {
        initialization = null
      }
    }
  }
}

internal fun McpStdioClient.awaitLeader(
  flight: CompletableFuture<Unit>,
  deadline: StatusRequestDeadline?,
) {
  val timeoutMs = deadline?.remainingTimeoutMs()
  try {
    if (timeoutMs == null) flight.get() else flight.get(timeoutMs, TimeUnit.MILLISECONDS)
  } catch (e: ExecutionException) {
    dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory.getLogger("McpStdioClient")
      .warn("MCP stdio response failed", e)
    val cause = e.cause
    throw McpConnectionException(cause?.message ?: "MCP stdio initialize failed", cause ?: e)
  } catch (_: TimeoutException) {
    throw McpConnectionException("MCP stdio request 'initialize' timed out after ${timeoutMs}ms")
  }
}

internal fun McpStdioClient.sendNotification(
  method: String,
  params: JsonElement? = null,
  deadline: StatusRequestDeadline? = null,
) {
  val request =
    JsonRpcRequest(
      id = null,
      method = method,
      params = params,
    )
  sendRequest(request, expectResponse = false, deadline = deadline)
}
