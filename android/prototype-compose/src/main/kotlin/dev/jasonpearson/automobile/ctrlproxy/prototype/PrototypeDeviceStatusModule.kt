package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypePlatformCalls
import dev.jasonpearson.automobile.prototype.PlatformAvailability
import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformError
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import dev.jasonpearson.automobile.prototype.PlatformEvent
import dev.jasonpearson.automobile.prototype.PrototypePlatformModule
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.JsonObject

interface PrototypeDeviceStatusSource {
  val state: StateFlow<JsonObject>

  fun close()
}

/** Atomic snapshots; StateFlow suppresses equal readings without restarting the event timer. */
class DeviceStatusTracker(initial: JsonObject = JsonObject(emptyMap())) {
  private val mutableState = MutableStateFlow(initial)
  val state: StateFlow<JsonObject> = mutableState.asStateFlow()

  fun update(reading: JsonObject) {
    mutableState.value = reading
  }
}

enum class DeviceStatusKind(val moduleName: String) {
  BATTERY("battery"),
  POWER("power"),
  AUDIO("audio"),
}

/** Read-only modules share connectivity's baseline and trailing debounce semantics. */
class PrototypeDeviceStatusModule(
  kind: DeviceStatusKind,
  private val source: PrototypeDeviceStatusSource,
) : PrototypePlatformModule {
  override val name = kind.moduleName
  override val capability = "prototype_platform_${name}_v1"
  private val changed = "$name.changed"
  private val debounceMs = checkNotNull(PrototypePlatformCalls.eventDebounceMs(changed))
  override val state: StateFlow<JsonObject>
    get() = source.state

  @OptIn(FlowPreview::class)
  override val events: Flow<PlatformEvent> = flow {
    val readings = source.state
    var delivered = readings.value
    readings.debounce(debounceMs).collect { value ->
      if (value != delivered) {
        delivered = value
        emit(PlatformEvent(changed, value))
      }
    }
  }

  override fun availability() = PlatformAvailability.Ready

  override suspend fun call(call: PlatformCall): PlatformCallResult =
    PlatformCallResult.Failure(
      PlatformError(PlatformErrorCode.UNSUPPORTED, "The $name module has no calls"),
    )

  override fun close() = source.close()
}
