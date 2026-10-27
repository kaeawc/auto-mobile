package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.prototype.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.json.JsonObject

/** Device state still comes from the host's measured window; debounce remains in PlatformState. */
internal class PrototypeDeviceModule(initial: JsonObject) : PrototypePlatformModule {
  override val name = "device"
  override val capability = "prototype_platform_device_v1"

  override fun availability() = PlatformAvailability.Ready

  private val mutableState = MutableStateFlow(initial)
  override val state = mutableState.asStateFlow()
  override val events = emptyFlow<PlatformEvent>()

  fun update(value: JsonObject) {
    mutableState.value = value
  }

  override suspend fun call(call: PlatformCall): PlatformCallResult =
    PlatformCallResult.Failure(
      PlatformError(PlatformErrorCode.UNSUPPORTED, "The device module has no calls"),
    )

  override fun close() = Unit
}
