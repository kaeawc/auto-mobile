package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypePlatformCalls
import dev.jasonpearson.automobile.prototype.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*

enum class PrototypePermissionState(val wire: String) {
  GRANTED("granted"),
  DENIED("denied"),
  BLOCKED("blocked"),
  NOT_DETERMINED("notDetermined"),
  LIMITED("limited"),
  RESTRICTED("restricted"),
  UNAVAILABLE("unavailable"),
}

sealed interface PrototypePermissionOutcome {
  data class Status(val state: PrototypePermissionState) : PrototypePermissionOutcome

  data object Busy : PrototypePermissionOutcome

  data object Cancelled : PrototypePermissionOutcome
}

/**
 * The runtime permissions an Android host can request for a spec, by contract name. Camera and
 * microphone are requested only by a spec that names them, never when a module registers.
 */
enum class PrototypeRuntimePermission(val wire: String, val manifest: String) {
  NOTIFICATIONS("notifications", "android.permission.POST_NOTIFICATIONS"),
  CAMERA("camera", "android.permission.CAMERA"),
  MICROPHONE("microphone", "android.permission.RECORD_AUDIO"),
}

/** One permission's authorization. One collection owns one permission-result registration. */
interface PrototypePermissionsSource {
  val changes: Flow<PrototypePermissionState>

  fun status(): PrototypePermissionState

  fun request(): Flow<PrototypePermissionOutcome>

  /** Stateful Android sources fork denial history; stateless sources may share the instance. */
  fun session(): PrototypePermissionsSource = this

  fun close()
}

class FakePrototypePermissionsSource : PrototypePermissionsSource {
  var current = PrototypePermissionState.NOT_DETERMINED
  override val changes = MutableSharedFlow<PrototypePermissionState>()
  var requests = 0
  var closed = false
  private val ended = CompletableDeferred<Unit>()
  var outcomes: Flow<PrototypePermissionOutcome> = flow {
    emit(PrototypePermissionOutcome.Status(current))
  }

  override fun status() = current

  override fun request(): Flow<PrototypePermissionOutcome> = flow {
    requests++
    coroutineScope {
      val outcome = async { outcomes.first() }
      try {
        emit(
          kotlinx.coroutines.selects.select {
            ended.onAwait { PrototypePermissionOutcome.Cancelled }
            outcome.onAwait { it }
          },
        )
      } finally {
        outcome.cancel()
      }
    }
  }

  override fun close() {
    closed = true
    ended.complete(Unit)
  }
}

/**
 * Each surface owns its state, events and denial history; the Activity coordinates prompts. Names
 * without a source report `unavailable` and never prompt.
 */
class PrototypePermissionsModule
private constructor(
  private val sources: Map<String, PrototypePermissionsSource>,
  scope: CoroutineScope?,
  private val owned: Set<PrototypePermissionsSource>,
) : PrototypePlatformModule {
  /** Notifications only, the shape every host registered before camera and microphone. */
  constructor(
    source: PrototypePermissionsSource,
    scope: CoroutineScope? = null,
  ) : this(mapOf(PrototypeRuntimePermission.NOTIFICATIONS.wire to source), scope, emptySet())

  constructor(
    sources: Map<PrototypeRuntimePermission, PrototypePermissionsSource>,
    scope: CoroutineScope? = null,
  ) : this(sources.mapKeys { it.key.wire }, scope, emptySet())

  companion object {
    const val CAPABILITY = "prototype_platform_permissions_v1"
  }

  private val moduleScope by lazy {
    scope ?: CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  }
  override val name = "permissions"
  override val capability = CAPABILITY
  private val mutableState =
    MutableStateFlow(
      buildJsonObject { sources.forEach { (name, source) -> put(name, source.status().wire) } },
    )
  private val mutableEvents = MutableSharedFlow<PlatformEvent>()
  private var changesJob: Job? = null
  private var closed = false
  private var inFlight = false
  override val events = mutableEvents.asSharedFlow()
  override val state: StateFlow<JsonObject>
    get() {
      if (!closed && changesJob == null) {
        changesJob =
          moduleScope.launch(start = CoroutineStart.UNDISPATCHED) {
            sources.forEach { (name, source) ->
              launch(start = CoroutineStart.UNDISPATCHED) {
                source.changes.collect { publish(name, it) }
              }
            }
          }
      }
      return mutableState.asStateFlow()
    }

  override fun availability() = PlatformAvailability.Ready

  internal val permissionReport: Map<String, String>
    get() = mutableState.value.mapValues { (_, value) -> value.jsonPrimitive.content }

  override suspend fun call(call: PlatformCall): PlatformCallResult {
    if (call.call != "permissions.request") return failure(PlatformErrorCode.UNSUPPORTED)
    if (PrototypePlatformCalls.argumentsError(call.call, call.args) != null)
      return failure(PlatformErrorCode.INVALID_ARGS)
    if (closed) return failure(PlatformErrorCode.UNAVAILABLE)
    if (inFlight) return failure(PlatformErrorCode.TOO_MANY_IN_FLIGHT)
    inFlight = true
    try {
      val results = linkedMapOf<String, JsonElement>()
      for (entry in call.args.getValue("names").jsonArray) {
        val name = entry.jsonPrimitive.content
        val source = sources[name]
        val state =
          if (source == null) PrototypePermissionState.UNAVAILABLE
          else
            when (val outcome = source.request().first()) {
              is PrototypePermissionOutcome.Status -> outcome.state
              PrototypePermissionOutcome.Busy ->
                return failure(PlatformErrorCode.TOO_MANY_IN_FLIGHT)
              PrototypePermissionOutcome.Cancelled -> return failure(PlatformErrorCode.CANCELLED)
            }
        publish(name, state)
        results[name] = JsonPrimitive(state.wire)
      }
      return PlatformCallResult.Success(buildJsonObject { put("results", JsonObject(results)) })
    } finally {
      inFlight = false
    }
  }

  private suspend fun publish(name: String, state: PrototypePermissionState) {
    val value = JsonPrimitive(state.wire)
    if (closed || mutableState.value[name] == value) return
    mutableState.update { JsonObject(it + (name to value)) }
    mutableEvents.emit(
      PlatformEvent(
        "permissions.changed",
        buildJsonObject {
          put("name", name)
          put("state", value)
        },
      ),
    )
  }

  internal fun session(scope: CoroutineScope): PrototypePermissionsModule {
    val sessions = sources.mapValues { it.value.session() }
    val forked = sessions.filter { (name, session) -> session !== sources[name] }.values.toSet()
    return PrototypePermissionsModule(sessions, scope, forked)
  }

  internal fun detach() {
    closed = true
    changesJob?.cancel()
    owned.forEach { it.close() }
  }

  override fun close() {
    detach()
    sources.values.forEach { it.close() }
  }

  private fun failure(code: PlatformErrorCode) =
    PlatformCallResult.Failure(
      PlatformError(code, "Permission request ${code.wireValue}"),
    )
}
