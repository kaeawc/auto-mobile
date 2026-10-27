package dev.jasonpearson.automobile.junit

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.SocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.concurrent.thread
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal object DaemonSocketClientManager : DaemonToolClient {
  override fun isAlive(): Boolean = DaemonSocketClient.isAvailable(DaemonSocketPaths.socketPath())

  override fun awaitAlive(timeoutMs: Long): Boolean =
    DaemonSocketClient.waitForAvailability(DaemonSocketPaths.socketPath(), timeoutMs)

  // Use ThreadLocal to give each thread its own socket connection
  // This enables true parallel execution since socket server queues requests per connection
  private val threadLocalClient = ThreadLocal<DaemonSocketClient>()

  override fun callTool(toolName: String, arguments: JsonObject, timeoutMs: Long): DaemonResponse =
    getOrCreateClient().callTool(toolName, arguments, timeoutMs)

  override fun readResource(uri: String, timeoutMs: Long): DaemonResponse =
    getOrCreateClient().readResource(uri, timeoutMs)

  override fun callDaemonMethod(
    method: String,
    params: JsonObject,
    timeoutMs: Long,
  ): DaemonResponse = getOrCreateClient().callDaemonMethod(method, params, timeoutMs)

  override var sessionUuid: String
    get() = getOrCreateClient().sessionUuid
    set(value) {
      getOrCreateClient().sessionUuid = value
    }

  // Decides when the daemon must be (re)started before a thread connects. A connect failure on an
  // already-ensured daemon (it died leaving its socket file behind) re-runs the ensure step once
  // instead of surfacing a raw "Connection refused" for every remaining test (#10169). Only a
  // dead-daemon failure whose PID-file process is gone triggers it; a local failure such as EMFILE
  // surfaces as-is so a healthy shared daemon is never restarted.
  private val connectionProvider =
    DaemonConnectionProvider(
      socketExists = { File(DaemonSocketPaths.socketPath()).exists() },
      ensureDaemon = { ensureDaemonRunning() },
      connect = { DaemonSocketClient(DaemonSocketPaths.socketPath()) },
      daemonProcessAlive = {
        DaemonSocketPaths.isProcessAlive(
          DaemonPidFiles.readDaemonPidFromPidFile(DaemonSocketPaths.pidFilePath()),
        )
      },
      nowMs = System::currentTimeMillis,
    )

  private fun getOrCreateClient(): DaemonSocketClient {
    // Each thread gets its own connection for parallel execution
    val existing = threadLocalClient.get()
    if (existing != null && existing.isConnected()) {
      return existing
    }

    val newClient = connectionProvider.open()
    threadLocalClient.set(newClient)
    return newClient
  }

  private fun ensureDaemonRunning() {
    DaemonLauncher.ensureRunning(
      DefaultDaemonLaunchEnvironment(resolveDaemonEnvironmentOverrides()),
    )
  }

  private fun resolveDaemonEnvironmentOverrides(): Map<String, String> {
    val resolvedOverrides = mutableMapOf<String, String>()
    val ctrlProxyApkProperty = SystemPropertyCache.get("automobile.ctrl.proxy.apk.path", "").trim()
    val ctrlProxyApkEnv = System.getenv("AUTOMOBILE_CTRL_PROXY_APK_PATH")?.trim().orEmpty()
    val ctrlProxyApkPath =
      when {
        ctrlProxyApkProperty.isNotEmpty() -> ctrlProxyApkProperty
        ctrlProxyApkEnv.isNotEmpty() -> ctrlProxyApkEnv
        else -> findLocalCtrlProxyApkPath().orEmpty()
      }
    if (ctrlProxyApkPath.isNotEmpty()) {
      resolvedOverrides["AUTOMOBILE_CTRL_PROXY_APK_PATH"] = ctrlProxyApkPath
    }
    return resolvedOverrides
  }

  private fun findLocalCtrlProxyApkPath(): String? {
    val candidates =
      listOf(
        File("control-proxy/build/outputs/apk/debug/control-proxy-debug.apk"),
        File("../control-proxy/build/outputs/apk/debug/control-proxy-debug.apk"),
        File("../../control-proxy/build/outputs/apk/debug/control-proxy-debug.apk"),
      )
    return candidates.firstOrNull { it.exists() }?.absolutePath
  }
}

internal data class DaemonForwardedFlag(
  val systemProperty: String,
  val envVar: String,
  val cliFlag: String,
)

/**
 * Configure with a JVM property (e.g. `-Dautomobile.daemon.dismiss.keyboard.after.input=true`) or
 * its environment variable.
 */
internal val DAEMON_FORWARDED_FLAGS =
  listOf(
    DaemonForwardedFlag(
      "automobile.daemon.dismiss.keyboard.after.input",
      "AUTOMOBILE_DAEMON_DISMISS_KEYBOARD_AFTER_INPUT",
      "--dismiss-keyboard-after-input",
    ),
    DaemonForwardedFlag(
      "automobile.daemon.no.ui.perf.mode",
      "AUTOMOBILE_DAEMON_NO_UI_PERF",
      "--no-ui-perf-mode",
    ),
    DaemonForwardedFlag(
      "automobile.daemon.no.navigation.screenshots",
      "AUTOMOBILE_DAEMON_NO_NAVIGATION_SCREENSHOTS",
      "--no-navigation-screenshots",
    ),
    DaemonForwardedFlag(
      "automobile.daemon.no.waitfor.polling.overhead",
      "AUTOMOBILE_DAEMON_NO_WAITFOR_POLLING_OVERHEAD",
      "--no-waitfor-polling-overhead",
    ),
    DaemonForwardedFlag(
      "automobile.daemon.no.include.not.important.views",
      "AUTOMOBILE_DAEMON_NO_INCLUDE_NOT_IMPORTANT_VIEWS",
      "--no-include-not-important-views",
    ),
    DaemonForwardedFlag(
      "automobile.daemon.no.report.view.ids",
      "AUTOMOBILE_DAEMON_NO_REPORT_VIEW_IDS",
      "--no-report-view-ids",
    ),
    DaemonForwardedFlag(
      "automobile.daemon.no.retrieve.interactive.windows",
      "AUTOMOBILE_DAEMON_NO_RETRIEVE_INTERACTIVE_WINDOWS",
      "--no-retrieve-interactive-windows",
    ),
  )

internal interface DaemonFlagEnvironment {
  fun flagProperty(name: String): Boolean

  fun env(name: String): String?
}

internal object SystemDaemonFlagEnvironment : DaemonFlagEnvironment {
  override fun flagProperty(name: String): Boolean = SystemPropertyCache.getBoolean(name, false)

  override fun env(name: String): String? = System.getenv(name)
}

internal fun forwardedDaemonFlags(environment: DaemonFlagEnvironment): List<String> {
  return DAEMON_FORWARDED_FLAGS.mapNotNull { flag ->
    val envValue = environment.env(flag.envVar)?.trim()?.lowercase().orEmpty()
    if (environment.flagProperty(flag.systemProperty) || envValue in setOf("1", "true", "yes")) {
      flag.cliFlag
    } else {
      null
    }
  }
}

internal object DaemonSocketPaths {

  /** Control socket, honouring overrides and `AUTOMOBILE_AUX_SOCKET_DIR` like the daemon. */
  fun socketPath(): String = DaemonStatePaths.resolve(DaemonStateFile.SOCKET, ::getUserId)

  /**
   * Lock file every runner JVM of this user takes around its daemon check-and-restart, so parallel
   * forks decide one at a time (#10170). Mirrors [socketPath] (per-uid, /tmp).
   */
  fun runnerRestartLockPath(): String = socketPath().removeSuffix(".sock") + ".runner-restart.lock"

  /** PID file the daemon writes its identity to. Resolved like [socketPath]. */
  fun pidFilePath(): String = DaemonStatePaths.resolve(DaemonStateFile.PID, ::getUserId)

  /**
   * Whether [pid] names a live process. An unknown pid is reported as not alive, so a daemon that
   * left no PID record can still be restarted.
   */
  internal fun isProcessAlive(
    pid: Long?,
    lookup: (Long) -> Boolean = { candidate ->
      ProcessHandle.of(candidate).map { it.isAlive }.orElse(false)
    },
  ): Boolean = pid != null && lookup(pid)

  private fun getUserId(): String {
    val userName = System.getProperty("user.name", "default").ifBlank { "default" }
    val osName = System.getProperty("os.name").lowercase()
    if (osName.contains("win")) {
      return userName
    }

    return try {
      val process = ProcessBuilder("id", "-u").start()
      val exitCode = process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)
      if (!exitCode) {
        process.destroy()
        return userName
      }
      val uid = process.inputStream.bufferedReader().readText().trim()
      if (uid.isNotEmpty()) uid else userName
    } catch (e: IOException) {
      println("User id lookup failed: $e")
      userName
    } catch (e: SecurityException) {
      println("User id lookup inaccessible: $e")
      userName
    } catch (e: InterruptedException) {
      println("User id lookup interrupted: $e")
      userName
    }
  }
}

internal class DaemonSocketClient(
  private val socketPath: String,
  private val clientVersion: String? = DaemonLaunchCommands.resolveClientVersion(),
  private val clientBuildId: String? = DaemonLocalBuild.resolveClientBuildId(),
  private val clientEntryScript: String? = DaemonLocalBuild.resolveLocalDaemonEntryScript(),
  private val livenessOwnerToken: String = DaemonLivenessOwner.token,
  private val responseObserver: ((DaemonResponse) -> Unit)? = null,
) : Closeable, DaemonToolClient {
  private val requests: DaemonPendingRequests
  @Volatile private var closed = false

  // Session UUID for per-thread plan execution locking.
  // Defaults to a random UUID but can be overridden by autolock session ID from startDevice.
  override var sessionUuid: String = UUID.randomUUID().toString()

  private val channel: SocketChannel = connect()
  private val reader: BufferedReader
  private val writer: BufferedWriter
  private val readThread: Thread

  init {
    val inputStream = Channels.newInputStream(channel)
    val outputStream = Channels.newOutputStream(channel)
    reader = BufferedReader(InputStreamReader(inputStream, StandardCharsets.UTF_8))
    writer = BufferedWriter(OutputStreamWriter(outputStream, StandardCharsets.UTF_8))
    requests = DaemonPendingRequests(writer)

    readThread =
      thread(start = true, isDaemon = true, name = "auto-mobile-daemon-reader") { readLoop() }
  }

  fun isConnected(): Boolean {
    return !closed && channel.isOpen
  }

  internal fun shutdownOutputForTest() {
    channel.shutdownOutput()
  }

  internal fun pendingRequestCount(): Int = requests.size

  override fun callTool(toolName: String, arguments: JsonObject, timeoutMs: Long): DaemonResponse {
    if (!isConnected()) {
      throw DaemonUnavailableException("Daemon socket connection is not available")
    }

    val requestId = UUID.randomUUID().toString()
    val request =
      DaemonRequest(
        id = requestId,
        type = "mcp_request",
        method = "tools/call",
        params = buildJsonParams(toolName, arguments),
        timeoutMs = timeoutMs,
        acceptsRequestBudget = true,
        clientVersion = clientVersion,
        clientBuildId = clientBuildId,
        clientEntryScript = clientEntryScript,
      )

    return requests.execute(request, timeoutMs)
  }

  override fun readResource(uri: String, timeoutMs: Long): DaemonResponse {
    if (!isConnected()) {
      throw DaemonUnavailableException("Daemon socket connection is not available")
    }

    val requestId = UUID.randomUUID().toString()
    val request =
      DaemonRequest(
        id = requestId,
        type = "mcp_request",
        method = "resources/read",
        params = JsonObject(mapOf("uri" to JsonPrimitive(uri))),
        timeoutMs = timeoutMs,
        acceptsRequestBudget = true,
        clientVersion = clientVersion,
        clientBuildId = clientBuildId,
        clientEntryScript = clientEntryScript,
      )

    return requests.execute(request, timeoutMs)
  }

  override fun callDaemonMethod(
    method: String,
    params: JsonObject,
    timeoutMs: Long,
  ): DaemonResponse = callDaemonMethod(method, timeoutMs, params)

  fun callDaemonMethod(
    method: String,
    timeoutMs: Long,
    params: JsonObject = JsonObject(emptyMap()),
  ): DaemonResponse {
    if (!isConnected()) {
      throw DaemonUnavailableException("Daemon socket connection is not available")
    }

    val requestId = UUID.randomUUID().toString()
    val request =
      DaemonRequest(
        id = requestId,
        type = "daemon_request",
        method = method,
        params = params,
        clientVersion = clientVersion,
        clientBuildId = clientBuildId,
        clientEntryScript = clientEntryScript,
      )

    return requests.execute(request, timeoutMs)
  }

  /**
   * Await a pending daemon response, translating failure modes into [DaemonUnavailableException] so
   * callers' retry/fallback can catch them, and always removing the pending entry (#3598).
   *
   * `failPendingRequests` completes the future with a [DaemonUnavailableException] when the read
   * loop dies; `future.get` then rethrows it wrapped in an [ExecutionException], so we unwrap it
   * here.
   */
  override fun close() {
    if (closed) {
      return
    }
    closed = true
    try {
      channel.close()
    } catch (e: IOException) {
      println("Daemon socket close failed: $e")
    }
    requests.failPendingRequests("Daemon socket closed")
  }

  private fun connect(): SocketChannel {
    if (!Files.exists(File(socketPath).toPath())) {
      throw DaemonSocketMissingException(socketPath)
    }

    // A daemon that died without unlinking its socket leaves the file behind, and the connect then
    // fails with a raw ConnectException. Surface it as the type callers' retry handling catches.
    return try {
      SocketChannel.open(UnixDomainSocketAddress.of(socketPath))
    } catch (e: IOException) {
      throw DaemonUnavailableException(
        "Daemon socket connect failed ($socketPath): ${e.message}",
        e,
      )
    }
  }

  private fun readLoop() {
    val frames =
      DaemonInboundFrames(
        onResponse = { response ->
          responseObserver?.invoke(response)
          requests.handleResponse(response)
        },
        onBudget = requests::adoptBudget,
      )
    try {
      while (!closed) {
        val line = reader.readLine() ?: break
        if (line.isBlank()) {
          continue
        }
        try {
          frames.handle(line)
        } catch (e: Exception) {
          // One bad frame must not end the reader and fail every pending request in the user's
          // test.
          println("Failed to handle daemon response: ${e.message}")
        }
      }
    } catch (e: IOException) {
      if (!closed) {
        println("Daemon socket read error: ${e.message}")
      }
    } finally {
      close()
    }
  }

  private fun buildJsonParams(toolName: String, arguments: JsonObject): JsonObject {
    // Include sessionUuid in tool arguments to enable per-thread plan execution locking
    val argumentsWithSession =
      JsonObject(
        arguments.toMutableMap().apply {
          if (!containsKey("sessionUuid")) {
            put("sessionUuid", JsonPrimitive(sessionUuid))
          }
          put("__autoMobileOwnedSessionsOwnerToken", JsonPrimitive(livenessOwnerToken))
        },
      )
    return JsonObject(mapOf("name" to JsonPrimitive(toolName), "arguments" to argumentsWithSession))
  }

  companion object {
    /**
     * Translate a [responseFuture.get] failure into a [DaemonUnavailableException] so callers'
     * retry/fallback (which catch that type) work. A disconnect surfaces as an [ExecutionException]
     * wrapping the [DaemonUnavailableException] that `failPendingRequests` set — unwrap it rather
     * than leaking the opaque wrapper (#3598).
     */
    internal fun mapAwaitFailure(e: Throwable, timeoutMs: Long): DaemonUnavailableException =
      when (e) {
        is TimeoutException ->
          DaemonUnavailableException("Daemon request timeout after ${timeoutMs}ms")
        is ExecutionException -> {
          val cause = e.cause
          (cause as? DaemonUnavailableException)
            ?: DaemonUnavailableException(
              "Daemon request failed: ${cause?.message ?: e.message}",
              cause,
            )
        }
        is InterruptedException -> DaemonUnavailableException("Daemon request interrupted")
        else -> DaemonUnavailableException("Daemon request failed: ${e.message}", e)
      }

    /**
     * Probe the daemon socket once, separating "no daemon is serving it" from a failure local to
     * this runner (e.g. EMFILE "Too many open files"), which must not trigger a restart of a shared
     * daemon that may be healthy (#10169).
     */
    internal fun probe(socketPath: String): DaemonProbe =
      try {
        DaemonSocketClient(socketPath).close()
        DaemonProbe.Available
      } catch (e: DaemonUnavailableException) {
        DaemonProbe.fromConnectFailure(e)
      } catch (e: IOException) {
        DaemonProbe.fromConnectFailure(e)
      }

    fun isAvailable(socketPath: String): Boolean {
      return try {
        val client = DaemonSocketClient(socketPath)
        client.close()
        true
      } catch (e: DaemonUnavailableException) {
        println("Daemon socket unavailable: $e")
        false
      } catch (e: IOException) {
        println("Daemon socket unavailable: $e")
        false
      } catch (e: UnsupportedOperationException) {
        println("Daemon socket unsupported: $e")
        false
      } catch (e: SecurityException) {
        println("Daemon socket inaccessible: $e")
        false
      } catch (e: IllegalArgumentException) {
        println("Invalid daemon socket path: $e")
        false
      }
    }

    fun waitForAvailability(socketPath: String, timeoutMs: Long): Boolean {
      val start = System.currentTimeMillis()
      while (System.currentTimeMillis() - start < timeoutMs) {
        if (isAvailable(socketPath)) {
          return true
        }
        Thread.sleep(100)
      }
      return false
    }
  }
}

@Serializable
internal data class DaemonRequest(
  val id: String,
  val type: String,
  val method: String,
  val params: JsonObject,
  val timeoutMs: Long? = null,
  val acceptsRequestBudget: Boolean? = null,
  // Declared for the daemon's server-side version handshake gate (#2744). Null on
  // legacy runners; the daemon allows those through.
  val clientVersion: String? = null,
  // Build identity (entry-script content hash + path) for the local-override case, so the gate
  // can distinguish two checkouts at the same release version. Null for the package path.
  val clientBuildId: String? = null,
  val clientEntryScript: String? = null,
)

@Serializable
internal data class DaemonResponse(
  val id: String,
  val type: String,
  val success: Boolean,
  val result: JsonElement? = null,
  val error: String? = null,
  /**
   * The typed refusal fields of a failed frame (`mcpRequestFailureDetails`), absent on older
   * daemons. Kept as raw elements so a field of an unexpected type is ignored instead of failing
   * the decode of the whole frame.
   */
  val code: JsonElement? = null,
  val retryable: JsonElement? = null,
  val nextAction: JsonElement? = null,
  val retryAfterMs: JsonElement? = null,
  val details: JsonElement? = null,
)

/** Interface for daemon tool calls to enable testing with fakes. */
internal interface DaemonToolClient {
  fun isAlive(): Boolean = true

  fun awaitAlive(timeoutMs: Long): Boolean = true

  fun callTool(toolName: String, arguments: JsonObject, timeoutMs: Long): DaemonResponse

  fun readResource(uri: String, timeoutMs: Long): DaemonResponse

  /**
   * Call a `daemon/...` control method. Clients that cannot reach the daemon's control methods
   * answer with a failed response rather than throwing, so a best-effort caller degrades cleanly.
   */
  fun callDaemonMethod(method: String, params: JsonObject, timeoutMs: Long): DaemonResponse =
    DaemonResponse(
      id = "",
      type = "daemon_response",
      success = false,
      error = "$method is not supported by this client",
    )

  var sessionUuid: String
}

internal open class DaemonUnavailableException(message: String, cause: Throwable? = null) :
  Exception(message, cause)

/** The daemon socket file does not exist: no daemon is serving it. */
internal class DaemonSocketMissingException(socketPath: String) :
  DaemonUnavailableException("Daemon socket not found: $socketPath")

/** Interface for checking daemon connectivity. Allows for easy testing with fakes. */
internal interface DaemonConnectivityChecker {
  fun isDaemonAlive(): Boolean

  fun waitForDaemon(timeoutMs: Long): Boolean
}

/** Connectivity follows the tool client; the default manager probes the actual daemon socket. */
internal class DefaultDaemonConnectivityChecker(
  private val daemon: DaemonToolClient = DaemonSocketClientManager,
) : DaemonConnectivityChecker {
  override fun isDaemonAlive(): Boolean = daemon.isAlive()

  override fun waitForDaemon(timeoutMs: Long): Boolean = daemon.awaitAlive(timeoutMs)
}
