package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer

internal val DAEMON_PATHS_LOG = LoggerFactory.getLogger("DaemonSocketPaths")
internal const val DAEMON_REGISTER_SESSION_METHOD = "daemon/registerSession"
internal const val DAEMON_CAPABILITIES_METHOD = "daemon/capabilities"
internal const val INPUT_TYPE_TEXT_APPEND_CAPABILITY = "input/typeText.mode:append"
internal const val INPUT_GESTURE_STREAM_CAPABILITY = "input/gestureStream"
internal const val OLD_DAEMON_CAPABILITIES_ERROR = "Unsupported daemon method: daemon/capabilities"
internal const val OLD_DAEMON_APPEND_MODE_ERROR = "input/typeText unsupported params: mode"
internal const val UNSUPPORTED_APPEND_MODE_ERROR =
  "The connected daemon does not support input/typeText mode:append. Restart or update the daemon before typing into the device."
internal const val SET_TOOL_ENABLED_TOOL_NAME = "setToolEnabled"
internal const val DAEMON_TOOL_SELECTION_PROFILE_PARAM = "__autoMobileToolSelectionProfileUuid"
internal const val DAEMON_OWNED_SESSIONS_PARAM = "__autoMobileOwnedSessionUuids"
internal val DEVICE_SESSION_ACQUISITION_TOOLS =
  setOf("getAndroid", "getApple", "startDevice", "provisionDevice")

private data class McpDaemonClientOptions(
  val socketPathValue: String = DaemonSocketPaths.socketPath(),
  val json: Json = DaemonJson,
  val clientVersion: String? = DaemonSocketPaths.resolveClientVersion(),
  val sessionUuid: String? = null,
  val inputSessionUuidProvider: () -> String? = { null },
  val requestTimeouts: DaemonRequestTimeouts = DaemonRequestTimeouts(),
)

class McpDaemonClient
private constructor(
  private val options: McpDaemonClientOptions,
  operations: McpDaemonOperationDelegates,
) :
  AutoMobileClient,
  AutoMobileDeviceOperations by operations.device,
  AutoMobileTestOperations by operations.test,
  AutoMobileFeatureOperations by operations.feature,
  AutoMobileStorageOperations by operations.storage,
  AutoMobileInputOperations by operations.input {
  init {
    operations.owner = this
  }

  constructor(
    socketPathValue: String = DaemonSocketPaths.socketPath(),
    json: Json = DaemonJson,
    clientVersion: String? = DaemonSocketPaths.resolveClientVersion(),
    sessionUuid: String? = null,
    inputSessionUuidProvider: () -> String? = { null },
    requestTimeouts: DaemonRequestTimeouts = DaemonRequestTimeouts(),
  ) : this(
    McpDaemonClientOptions(
      socketPathValue,
      json,
      clientVersion,
      sessionUuid,
      inputSessionUuidProvider,
      requestTimeouts,
    ),
    McpDaemonOperationDelegates(),
  )

  internal val socketPathValue
    get() = options.socketPathValue

  internal val json
    get() = options.json

  internal val clientVersion
    get() = options.clientVersion

  val sessionUuid
    get() = options.sessionUuid

  internal val inputSessionUuidProvider
    get() = options.inputSessionUuidProvider

  internal val requestTimeouts
    get() = options.requestTimeouts

  internal val inputRequestTimeoutMs
    get() = requestTimeouts.inputRequestTimeoutMs

  internal val statusRequestTimeoutMs
    get() = requestTimeouts.statusRequestTimeoutMs

  internal val sessionKeepaliveTimeoutMs
    get() = requestTimeouts.sessionKeepaliveTimeoutMs

  internal var daemonLifecycle: DaemonLifecycleEnsurer? =
    if (socketPathValue == DaemonSocketPaths.socketPath()) DesktopDaemonLifecycle() else null

  internal constructor(
    socketPathValue: String,
    daemonLifecycle: DaemonLifecycleEnsurer,
    statusRequestTimeoutMs: Long = STATUS_REQUEST_TIMEOUT_MS,
    sessionUuid: String? = null,
    sessionKeepaliveTimeoutMs: Long = SESSION_KEEPALIVE_TIMEOUT_MS,
  ) : this(
    socketPathValue = socketPathValue,
    sessionUuid = sessionUuid,
    requestTimeouts =
      DaemonRequestTimeouts(
        statusRequestTimeoutMs = statusRequestTimeoutMs,
        sessionKeepaliveTimeoutMs = sessionKeepaliveTimeoutMs,
      ),
  ) {
    this.daemonLifecycle = daemonLifecycle
  }

  internal var requestTransport: DaemonRequestTransport? = null

  internal constructor(
    requestTransport: DaemonRequestTransport,
    json: Json = DaemonJson,
    sessionUuid: String? = null,
  ) : this(
    socketPathValue = "in-memory-daemon",
    json = json,
    clientVersion = null,
    sessionUuid = sessionUuid,
  ) {
    this.daemonLifecycle = null
    this.requestTransport = requestTransport
  }

  val socketPath: String
    get() = socketPathValue

  override val transportName: String = "Unix Socket"
  override val connectionDescription: String
    get() = socketPathValue

  internal val deviceGestureRecordingClient = DeviceGestureRecordingSocketClient()
  internal var daemonCapabilities: CachedDaemonCapabilities? = null
  internal val ownedSessionUuids =
    ConcurrentHashMap.newKeySet<String>().apply { sessionUuid?.let(::add) }
  internal var toolSelectionProfileUuid: String? = null

  override fun ping() {
    val response = sendRequest("ide/ping")
    ensureSuccess(response)
  }

  override fun listResources(): List<McpResource> {
    val response = sendRequest("resources/list")
    val responseResult = ensureSuccess(response, "resources/list")
    val result = json.decodeFromJsonElement(serializer<ListResourcesResult>(), responseResult)
    return result.resources
  }

  override fun listResourceTemplates(): List<McpResourceTemplate> {
    val response = sendRequest("resources/list-templates")
    val responseResult = ensureSuccess(response, "resources/list-templates")
    val result =
      json.decodeFromJsonElement(serializer<ListResourceTemplatesResult>(), responseResult)
    return result.resourceTemplates
  }

  override fun listTools(): List<McpTool> {
    val response =
      sendRequest(
        "tools/list",
        toolSelectionProfileUuid?.let { profileUuid ->
          buildJsonObject {
            put(DAEMON_TOOL_SELECTION_PROFILE_PARAM, JsonPrimitive(profileUuid))
          }
        } ?: JsonObject(emptyMap()),
      )
    val responseResult = ensureSuccess(response, "tools/list")
    val result = json.decodeFromJsonElement(serializer<ListToolsResult>(), responseResult)
    return result.tools
  }

  override fun readResource(uri: String): List<McpResourceContent> {
    val response =
      sendRequest(
        "resources/read",
        buildJsonObject { put("uri", JsonPrimitive(uri)) },
      )
    val responseResult = ensureSuccess(response, "resources/read")
    val result = json.decodeFromJsonElement(serializer<ReadResourceResult>(), responseResult)
    return result.contents
  }

  override fun callTool(name: String, arguments: JsonObject): JsonElement {
    // A device read never needs a session (#11364): naming this client's UUID would make the read
    // fail with that session's terminal or suspect error between a release and the rotation.
    val skipsClientSession = name == SET_TOOL_ENABLED_TOOL_NAME || "sessionUuid" in arguments
    val sessionArguments =
      if (sessionUuid != null && !skipsClientSession && !isDeviceReadCall(name, arguments)) {
        buildJsonObject {
          arguments.forEach { (key, value) -> put(key, value) }
          put("sessionUuid", JsonPrimitive(sessionUuid))
        }
      } else {
        arguments
      }
    val ownershipArguments =
      if (name != SET_TOOL_ENABLED_TOOL_NAME && ownedSessionUuids.isNotEmpty()) {
        buildJsonObject {
          sessionArguments.forEach { (key, value) -> put(key, value) }
          put(
            DAEMON_OWNED_SESSIONS_PARAM,
            JsonArray(ownedSessionUuids.toList().sorted().map(::JsonPrimitive)),
          )
        }
      } else {
        sessionArguments
      }
    val profileUuid = toolSelectionProfileUuid
    val routedArguments =
      if (name == SET_TOOL_ENABLED_TOOL_NAME || profileUuid == null) ownershipArguments
      else
        buildJsonObject {
          ownershipArguments.forEach { (key, value) -> put(key, value) }
          put(DAEMON_TOOL_SELECTION_PROFILE_PARAM, JsonPrimitive(profileUuid))
        }
    val response =
      sendRequest(
        "tools/call",
        buildJsonObject {
          put("name", JsonPrimitive(name))
          put("arguments", routedArguments)
        },
      )
    ensureSuccess(response)
    val result = response.result ?: JsonObject(emptyMap())
    recordResultMintedSession(name, result)
    return result
  }

  /**
   * Registers an identity without binding or reserving any device.
   *
   * Runs from the session's heartbeat loop, so it never runs the lifecycle preflight (#11072): a
   * missing or other-version daemon is a lapse the loop retries, never a reason to start or restart
   * the shared daemon. Only user-initiated requests (input, Retry) run the preflight.
   */
  fun registerSession(sessionId: String, clientName: String): RegisterSessionResult {
    val response =
      sendRequest(
        DAEMON_REGISTER_SESSION_METHOD,
        json.encodeToJsonElement(RegisterSessionRequest(sessionId, clientName)).jsonObject,
        timeoutMs = sessionKeepaliveTimeoutMs,
        skipLifecyclePreflight = true,
      )
    val responseResult = ensureSuccess(response, "daemon/registerSession")
    return json.decodeFromJsonElement(serializer<RegisterSessionResult>(), responseResult)
  }

  /** Releases this client's daemon session, if it owns one. */
  internal fun releaseSession() {
    val sessionId = sessionUuid ?: return
    val response =
      sendRequest(
        "daemon/releaseSession",
        buildJsonObject { put("sessionId", JsonPrimitive(sessionId)) },
      )
    ensureSuccess(response)
    ownedSessionUuids.remove(sessionId)
  }

  /**
   * Refreshes the heartbeat for this client's daemon session, if it owns one.
   *
   * A passive keep-alive (#11072): it skips the lifecycle preflight, so a heartbeat tick never
   * starts a daemon the user stopped or restarts one of another version (which dropped every other
   * harness's sessions), and it is bounded by [sessionKeepaliveTimeoutMs]. A missing or wedged
   * daemon fails the tick, which the session loop treats as a lapse.
   */
  internal fun heartbeatSession() {
    val sessionId = sessionUuid ?: return
    val response =
      sendRequest(
        "daemon/heartbeat",
        buildJsonObject { put("sessionId", JsonPrimitive(sessionId)) },
        timeoutMs = sessionKeepaliveTimeoutMs,
        skipLifecyclePreflight = true,
      )
    if (!response.success && response.code?.contentOrNull == SESSION_NOT_FOUND_CODE) {
      throw DaemonSessionNotFoundException(
        response.error ?: "Session not found",
        response.releaseReason,
      )
    }
    ensureSuccess(response)
  }

  override fun setToolEnabled(
    toolName: String,
    enabled: Boolean,
  ) {
    val response =
      callToolChecked(
        SET_TOOL_ENABLED_TOOL_NAME,
        buildJsonObject {
          put("toolName", JsonPrimitive(toolName))
          put("enabled", JsonPrimitive(enabled))
          toolSelectionProfileUuid?.let {
            put(DAEMON_TOOL_SELECTION_PROFILE_PARAM, JsonPrimitive(it))
          }
        },
      )
    toolSelectionProfileUuid =
      (response as? JsonObject)?.get("sessionUuid")?.jsonPrimitive?.contentOrNull
        ?: throw DaemonUnavailableException("Tool-selection response missing profile UUID")
  }

  companion object {

    /** Hang ceiling for the input helpers; a healthy input round-trip is ~milliseconds. */
    /** Hang ceiling for ordinary daemon requests (tool calls can legitimately take tens of s). */
    const val INPUT_REQUEST_TIMEOUT_MS = 5_000L

    /**
     * Hang ceiling for the daemon connectivity probe (ide/status); a healthy probe is ~ms (#4858).
     */
    const val STATUS_REQUEST_TIMEOUT_MS = 5_000L

    /** Hang ceiling for `daemon/heartbeat` and `daemon/registerSession` (#11072). */
    const val SESSION_KEEPALIVE_TIMEOUT_MS = 2_000L

    // One shared daemon thread arms/cancels every request deadline. It only ever runs a
    // channel.close() for a request that overran its ceiling, so it stays idle in normal use.
    internal val requestWatchdog =
      java.util.concurrent.Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "daemon-request-watchdog").apply { isDaemon = true }
      }
  }
}

object DaemonSocketPaths {
  private val ignoredVersions = setOf("latest", "unknown")

  /**
   * The uid cannot change during a run, so it is resolved once per process (#10238). Before this it
   * forked `id -u` on every path lookup: four forks ahead of each click-to-tap or keystroke, and
   * one per root recomposition on the UI thread.
   */
  private val processUserId = CachedDaemonUserId()

  fun socketPath(): String = socketPath(processUserId)

  fun pidFilePath(): String = pidFilePath(processUserId)

  internal fun socketPath(
    userId: CachedDaemonUserId,
    envProvider: (String) -> String? = System::getenv,
  ): String =
    AutoMobileSocketPaths.daemonStatePath(DaemonStateFile.SOCKET, { userId.value }, envProvider)

  internal fun pidFilePath(
    userId: CachedDaemonUserId,
    envProvider: (String) -> String? = System::getenv,
  ): String =
    AutoMobileSocketPaths.daemonStatePath(DaemonStateFile.PID, { userId.value }, envProvider)

  /** Version this desktop client declares to the daemon's version handshake gate. */
  fun resolveClientVersion(): String? =
    resolveClientVersion(
      daemonPackageVersion = System.getenv("AUTOMOBILE_DAEMON_PACKAGE_VERSION"),
      automobileVersion = System.getenv("AUTOMOBILE_VERSION"),
      manifestVersion =
        DaemonSocketPaths::class.java.`package`?.implementationVersion ?: DesktopBuildInfo.VERSION,
    )

  internal fun resolveClientVersion(
    daemonPackageVersion: String?,
    automobileVersion: String?,
    manifestVersion: String?,
  ): String? =
    sequenceOf(daemonPackageVersion, automobileVersion, manifestVersion)
      .mapNotNull(::normalizeClientVersion)
      .firstOrNull()

  internal fun normalizeClientVersion(raw: String?): String? {
    val trimmed = raw?.trim().orEmpty()
    if (trimmed.isEmpty() || ignoredVersions.contains(trimmed.lowercase())) {
      return null
    }
    // A Gradle dev build stamps `<release>-SNAPSHOT` (e.g. `0.0.67-SNAPSHOT`). The daemon's
    // handshake gate compares release strings, and `-SNAPSHOT` is a semver prerelease — not `+`
    // build metadata — so an unstripped SNAPSHOT can never match the published daemon it tracks
    // (`0.0.67-SNAPSHOT` != `0.0.67`), and `bunx @kaeawc/auto-mobile@0.0.67-SNAPSHOT` names a
    // package that does not exist on npm. Declare the base release instead so a dev-run desktop
    // connects to the current installed daemon, and can install the real package when none runs.
    val snapshotBase =
      trimmed
        .takeIf { it.endsWith(SNAPSHOT_SUFFIX, ignoreCase = true) }
        ?.dropLast(SNAPSHOT_SUFFIX.length)
    if (snapshotBase != null) {
      return snapshotBase.takeIf { it.isNotEmpty() }
    }
    return trimmed
  }

  internal const val SNAPSHOT_SUFFIX = "-SNAPSHOT"

  internal fun releaseVersion(version: String): String = version.substringBefore('+')
}

/**
 * The daemon's per-user socket/PID file suffix, resolved at most once per instance. Thread-safe:
 * concurrent first callers share one lookup. [lookup] is injectable so tests count invocations
 * without forking a process.
 */
internal class CachedDaemonUserId(private val lookup: () -> String = ::lookupDaemonUserId) {
  val value: String by lazy(LazyThreadSafetyMode.SYNCHRONIZED) { lookup() }
}

private fun lookupDaemonUserId(): String =
  resolveDaemonUserId(
    userName = System.getProperty("user.name", "default").ifBlank { "default" },
    osName = System.getProperty("os.name", "").lowercase(),
    readUid = ::forkUid,
  )

/**
 * Windows and any failed or empty `id -u` read fall back to [userName], exactly as the previous
 * per-call lookup did.
 */
internal fun resolveDaemonUserId(userName: String, osName: String, readUid: () -> String): String {
  if (osName.contains("win")) {
    return userName
  }
  return try {
    readUid().trim().ifEmpty { userName }
  } catch (cancellation: kotlin.coroutines.cancellation.CancellationException) {
    throw cancellation
  } catch (e: IllegalStateException) {
    // The user name is the documented fallback identifier when `id -u` is unavailable.
    DAEMON_PATHS_LOG.debug("Could not read the user id; using the user name: ${e.message}")
    userName
  } catch (e: java.io.IOException) {
    // The user name is the documented fallback identifier when `id -u` is unavailable.
    DAEMON_PATHS_LOG.debug("Could not read the user id; using the user name: ${e.message}")
    userName
  } catch (e: InterruptedException) {
    // The user name is the documented fallback identifier when `id -u` is unavailable.
    DAEMON_PATHS_LOG.debug("Could not read the user id; using the user name: ${e.message}")
    userName
  } catch (e: SecurityException) {
    // A security policy that denies subprocesses makes `id -u` unavailable too (#14571).
    DAEMON_PATHS_LOG.debug("Could not read the user id; using the user name: ${e.message}")
    userName
  }
}

/** Runs `id -u`; a timeout yields an empty string so the caller falls back to the user name. */
private fun forkUid(): String {
  val process = ProcessBuilder("id", "-u").start()
  if (!process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) {
    process.destroy()
    return ""
  }
  return process.inputStream.bufferedReader().readText()
}

@Serializable data class RegisterSessionRequest(val sessionId: String, val clientName: String)

@Serializable
data class RegisterSessionResult(
  val accepted: Boolean,
  val heartbeatTimeoutMs: Long,
  val expiresAtMs: Long,
)

/** In-memory request seam; production continues to use the daemon socket. */
internal fun interface DaemonRequestTransport {
  fun send(request: DaemonRequest): DaemonResponse
}

@Serializable
internal data class DaemonRequest(
  val id: String,
  val type: String,
  val method: String,
  val params: JsonObject,
  val clientVersion: String? = null,
  /** Caller's deadline in ms; omitted (explicitNulls = false) when the call is unbounded. */
  val timeoutMs: Long? = null,
)

@Serializable
data class DaemonResponse(
  val id: String,
  val type: String,
  val success: Boolean,
  val result: JsonElement? = null,
  val error: String? = null,
  /**
   * The daemon's structured error code: a string such as [DEVICE_OWNED_BY_OTHER_SESSION_CODE], or a
   * JSON-RPC number (`src/daemon/types.ts`), so it is kept as a primitive.
   */
  val code: JsonPrimitive? = null,
  /**
   * With a session-not-found [code]: why the daemon released a session it knows (e.g.
   * `heartbeat-timeout`, `cleanup-expired`); absent for a UUID it never issued (#10730).
   */
  val releaseReason: String? = null,
  /** Whether retrying the same call can succeed (failure frames, `src/daemon/types.ts`). */
  val retryable: Boolean? = null,
  /**
   * Structured context on a failure frame: `deviceId`, `boundSessionUuid`, `sessionUuid`, `reason`,
   * and `remainingMs` for a suspect session.
   */
  val details: JsonObject? = null,
)

@Serializable internal data class DaemonCapabilitiesResult(val capabilities: List<String>)

internal data class SocketIdentity(
  val path: String,
  val fileKey: String,
)

internal data class CachedDaemonCapabilities(
  val identity: SocketIdentity,
  val capabilities: Set<String>,
)

internal sealed interface DaemonCapabilitiesProbe {
  data class Available(val capabilities: Set<String>) : DaemonCapabilitiesProbe

  data object Legacy : DaemonCapabilitiesProbe

  data class Failure(val error: String) : DaemonCapabilitiesProbe
}

internal val sharedDaemonCapabilities = ConcurrentHashMap<SocketIdentity, Set<String>>()

open class DaemonUnavailableException(message: String) : McpConnectionException(message)

/** The daemon answered "session not found" and, for a session it released, [releaseReason] why. */
class DaemonSessionNotFoundException(message: String, val releaseReason: String?) :
  DaemonUnavailableException(message)

/** The wire `code` of a session-not-found answer (`DAEMON_SESSION_NOT_FOUND_CODE` in types.ts). */
internal const val SESSION_NOT_FOUND_CODE = "daemon_session_not_found"

/** Independent hang ceilings for input frames, passive status, and session keep-alives. */
data class DaemonRequestTimeouts(
  val inputRequestTimeoutMs: Long = McpDaemonClient.INPUT_REQUEST_TIMEOUT_MS,
  val statusRequestTimeoutMs: Long = McpDaemonClient.STATUS_REQUEST_TIMEOUT_MS,
  val sessionKeepaliveTimeoutMs: Long = McpDaemonClient.SESSION_KEEPALIVE_TIMEOUT_MS,
)
