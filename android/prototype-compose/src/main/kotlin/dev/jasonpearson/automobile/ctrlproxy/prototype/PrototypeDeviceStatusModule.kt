package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypePlatformCalls
import dev.jasonpearson.automobile.protocol.PrototypeSpecError
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

/**
 * Atomic snapshots; StateFlow suppresses equal readings without restarting the event timer. Real
 * readings pass through a [DeviceStatusOverride], so fake mode and `simulate state` seeds (#14300)
 * replace them until the mode returns to real.
 */
class DeviceStatusTracker(initial: JsonObject = JsonObject(emptyMap())) {
  private val override = DeviceStatusOverride(platform = "android").apply { reading(initial) }
  private val mutableState = MutableStateFlow(initial)
  val state: StateFlow<JsonObject> = mutableState.asStateFlow()

  @Synchronized
  fun update(reading: JsonObject) {
    override.reading(reading)
    publish()
  }

  @Synchronized
  fun mode(mode: DeviceStatusMode) {
    override.mode(mode)
    publish()
  }

  /** The refusal for a seed the contract or the current mode rejects, or null once it shows. */
  @Synchronized
  fun seed(kind: DeviceStatusKind, seed: JsonObject): PrototypeSpecError? =
    override.seed(kind.moduleName, seed).also { publish() }

  private fun publish() {
    override.shown?.let { mutableState.value = it }
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
