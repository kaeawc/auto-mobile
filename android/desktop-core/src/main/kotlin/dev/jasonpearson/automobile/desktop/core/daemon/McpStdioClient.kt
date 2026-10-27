package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.BufferedWriter
import java.util.concurrent.Callable
import java.util.concurrent.CompletableFuture
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

data class McpStdioOptions(
  val statusRequestTimeoutMs: Long = McpDaemonClient.STATUS_REQUEST_TIMEOUT_MS,
  val statusDeadlineFactory: (Long) -> StatusRequestDeadline = {
    StatusRequestDeadline(it)
  },
  val processStarter: (List<String>) -> Process = { commandParts ->
    ProcessBuilder(commandParts).redirectError(ProcessBuilder.Redirect.INHERIT).start()
  },
  val responseReader: StdioResponseReader = StdioResponseReader { read, _ -> read.call() },
  val restartPolicy: StdioRestartPolicy = StdioRestartPolicy(),
  val nowNanos: () -> Long = System::nanoTime,
)

class McpStdioClient(
  internal val command: String,
  override val json: Json = DaemonJson,
  options: McpStdioOptions = McpStdioOptions(),
) : StdioMutationOperations() {
  internal val statusRequestTimeoutMs = options.statusRequestTimeoutMs
  internal val statusDeadlineFactory = options.statusDeadlineFactory
  internal val processStarter = options.processStarter
  internal val responseReader = options.responseReader
  internal val restartPolicy = options.restartPolicy
  internal val nowNanos = options.nowNanos

  override val transportName: String = "MCP STDIO"
  override val connectionDescription: String = command

  internal val protocolJson: Json
    get() = json

  internal val ioLock = Any()
  internal var process: Process? = null
  internal var processStartedAtNanos = 0L
  internal var writer: BufferedWriter? = null
  internal var pump: StdioResponsePump? = null
  internal var initialized = false

  /**
   * The start-and-`initialize` handshake in progress, if any. Callers that arrive while it runs
   * wait on it instead of starting a second child or sending a second `initialize`.
   */
  internal var initialization: CompletableFuture<Unit>? = null
  internal val restartGuard = StdioRestartGuard(restartPolicy, nowNanos)

  override fun ping() {
    ensureInitialized()
  }

  override fun listResources(): List<McpResource> {
    ensureInitialized()
    val response = sendRequest("resources/list")
    val result =
      json.decodeFromJsonElement(
        serializer<ListResourcesResult>(),
        response.resultFor("resources/list"),
      )
    return result.resources
  }

  override fun listResourceTemplates(): List<McpResourceTemplate> {
    ensureInitialized()
    val response = sendRequest("resources/list-templates")
    val result =
      json.decodeFromJsonElement(
        serializer<ListResourceTemplatesResult>(),
        response.resultFor("resources/list-templates"),
      )
    return result.resourceTemplates
  }

  override fun listTools(): List<McpTool> {
    ensureInitialized()
    val response = sendRequest("tools/list")
    val result =
      json.decodeFromJsonElement(serializer<ListToolsResult>(), response.resultFor("tools/list"))
    return result.tools
  }

  override fun readResource(uri: String): List<McpResourceContent> {
    ensureInitialized()
    val response =
      sendRequest(
        "resources/read",
        buildJsonObject { put("uri", JsonPrimitive(uri)) },
      )
    val result =
      json.decodeFromJsonElement(
        serializer<ReadResourceResult>(),
        response.resultFor("resources/read"),
      )
    return result.contents
  }

  override fun getDaemonStatus():
    dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse {
    val deadline = statusDeadlineFactory(statusRequestTimeoutMs)
    val response =
      callToolWithTimeout(
        "getDaemonStatus",
        JsonObject(emptyMap()),
        deadline,
      )
    return try {
      decodeToolResponse(
        json,
        response,
        serializer<dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse>(),
      )
    } catch (e: IllegalArgumentException) {
      dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory.getLogger("McpStdioClient")
        .warn("Failed to decode daemon status", e)
      dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse()
    } catch (e: McpConnectionException) {
      dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory.getLogger("McpStdioClient")
        .warn("Failed to decode daemon status", e)
      dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse()
    }
  }

  override fun callTool(name: String, arguments: JsonObject): JsonElement {
    return callToolWithTimeout(name, arguments)
  }

  override fun close() {
    synchronized(ioLock) {
      try {
        writer?.flush()
      } catch (_: IllegalArgumentException) {} catch (_: McpConnectionException) {}
      process?.destroy()
      process = null
      writer = null
      pump = null
      initialized = false
      // A handshake still running on another thread fails when its pipe closes; a caller arriving
      // after close() must start afresh rather than join it.
      initialization = null
    }
  }

  /**
   * Makes sure a started, initialized child is available. A child that has exited is replaced here,
   * on the next request after the exit: the new child is started and `initialize`d exactly once
   * however many callers arrive together (one leader, the rest wait on its handshake).
   */
  internal class InitializationClaim(val flight: CompletableFuture<Unit>, val leader: Boolean)

  /** Null when a live, initialized child is already available. */
  internal class DispatchedRequest(val process: Process, val pending: PendingResponse?)

  /**
   * Writes [request] to the running child. Must hold [ioLock]. A request is only ever written to a
   * child that has completed `initialize` (or is being asked to), and never starts a child itself:
   * starting is [claimInitialization]'s job, so a child that vanished since the caller's
   * `ensureInitialized` produces a clear error instead of a silently uninitialized replacement.
   */

  /** Kills a wedged child on purpose. Not an unexpected exit, so it does not feed the throttle. */

  /**
   * Forgets [current] so the next request starts a new child. Must hold [ioLock]. Does nothing when
   * [current] was already replaced, so a death seen by several threads is counted once.
   */

  /**
   * Retires a child that has exited since the last request. Must hold [ioLock]. Returns whether one
   * was retired.
   */
  internal class PendingResponse(private val id: String, private val pump: StdioResponsePump) {
    val future = pump.register(id)

    fun abandon() = pump.abandon(id)
  }

  /** Starts the child unless one is running. Must hold [ioLock]. */
}

fun interface StdioResponseReader {
  fun read(read: Callable<JsonRpcResponse>, timeoutMs: Long?): JsonRpcResponse
}
