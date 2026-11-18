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

/** Notification authorization only. One collection owns one permission-result registration. */
interface PrototypePermissionsSource {
  val changes: Flow<PrototypePermissionState>

  fun status(): PrototypePermissionState

  fun request(): Flow<PrototypePermissionOutcome>

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

/** Each surface owns its state and events; the Activity owns the shared permission source. */
class PrototypePermissionsModule(
  private val source: PrototypePermissionsSource,
  scope: CoroutineScope? = null,
) : PrototypePlatformModule {
  companion object {
    const val CAPABILITY = "prototype_platform_permissions_v1"
  }

  private val moduleScope by lazy {
    scope ?: CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  }
  override val name = "permissions"
  override val capability = CAPABILITY
  private val mutableState =
    MutableStateFlow(buildJsonObject { put("notifications", source.status().wire) })
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
            source.changes.collect { publish("notifications", it) }
          }
      }
      return mutableState.asStateFlow()
    }

  override fun availability() = PlatformAvailability.Ready

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
        val state =
          if (name == "notifications") {
            when (val outcome = source.request().first()) {
              is PrototypePermissionOutcome.Status -> outcome.state
              PrototypePermissionOutcome.Busy ->
                return failure(PlatformErrorCode.TOO_MANY_IN_FLIGHT)
              PrototypePermissionOutcome.Cancelled -> return failure(PlatformErrorCode.CANCELLED)
            }
          } else PrototypePermissionState.UNAVAILABLE
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

  internal fun session(scope: CoroutineScope) = PrototypePermissionsModule(source, scope)

  internal fun detach() {
    closed = true
    changesJob?.cancel()
  }

  override fun close() {
    detach()
    source.close()
  }

  private fun failure(code: PlatformErrorCode) =
    PlatformCallResult.Failure(
      PlatformError(code, "Permission request ${code.wireValue}"),
    )
}
