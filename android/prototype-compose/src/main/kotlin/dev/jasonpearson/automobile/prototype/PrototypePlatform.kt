package dev.jasonpearson.automobile.prototype

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Availability is checked for each call; registering a module never requests permission. */
sealed interface PlatformAvailability {
  data object Ready : PlatformAvailability

  data class Unavailable(val reason: String) : PlatformAvailability

  data class NeedsPermission(val names: Set<String>) : PlatformAvailability
}

data class PlatformCall(val callId: String, val call: String, val args: JsonObject)

data class PlatformEvent(val name: String, val data: JsonObject)

enum class PlatformErrorCode(val wireValue: String) {
  UNSUPPORTED("unsupported"),
  UNAVAILABLE("unavailable"),
  PERMISSION_DENIED("permission_denied"),
  INVALID_ARGS("invalid_args"),
  CANCELLED("cancelled"),
  TIMEOUT("timeout"),
  TOO_MANY_IN_FLIGHT("too_many_in_flight"),
  PLATFORM_ERROR("platform_error"),
}

data class PlatformError(val code: PlatformErrorCode, val message: String)

sealed interface PlatformCallResult {
  data class Success(val value: JsonElement) : PlatformCallResult

  data class Failure(val error: PlatformError) : PlatformCallResult
}

/** Modules own their resources. Calls return typed failures and propagate cancellation. */
interface PrototypePlatformModule {
  val name: String
  val capability: String

  fun availability(): PlatformAvailability

  suspend fun call(call: PlatformCall): PlatformCallResult

  val events: Flow<PlatformEvent>
  val state: StateFlow<JsonObject>

  fun close()
}

/** Immutable membership; state and availability remain live. Duplicate namespaces are refused. */
class PrototypePlatformRegistry(modules: List<PrototypePlatformModule>) {
  val modules: List<PrototypePlatformModule> = modules.toList()

  init {
    require(this.modules.map { it.name }.distinct().size == this.modules.size)
    require(this.modules.all { it.name.isNotBlank() && '/' !in it.name && '.' !in it.name })
  }

  val capabilities: Set<String> = this.modules.map { it.capability }.toSortedSet()

  internal fun module(call: String): PrototypePlatformModule? = modules.firstOrNull {
    it.name == call.substringBefore('.')
  }
}

/**
 * App-owned modules, empty by default. Instances have identity semantics: remember this value;
 * replacing it reloads the embedded runtime. The app closes modules after all renderers detach.
 */
class PrototypePlatform(val registry: PrototypePlatformRegistry) {
  constructor(modules: List<PrototypePlatformModule>) : this(PrototypePlatformRegistry(modules))

  val capabilities: Set<String>
    get() = AutoMobilePrototype.capabilities(this)

  companion object {
    val None = PrototypePlatform(emptyList())
  }
}
