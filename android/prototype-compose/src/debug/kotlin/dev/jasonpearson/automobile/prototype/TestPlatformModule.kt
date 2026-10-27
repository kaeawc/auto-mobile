package dev.jasonpearson.automobile.prototype

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.*

/** Contract test module, absent from release artifacts. Tick is an event, echo is a call. */
class TestPlatformModule(private val wait: suspend (Long) -> Unit = { delay(it) }) :
  PrototypePlatformModule {
  override val name = "test"
  override val capability = "prototype_platform_test_v1"

  override fun availability() = PlatformAvailability.Ready

  private val mutableEvents = MutableSharedFlow<PlatformEvent>()
  override val events = mutableEvents.asSharedFlow()
  private val mutableState = MutableStateFlow(JsonObject(emptyMap()))
  override val state = mutableState.asStateFlow()

  override suspend fun call(call: PlatformCall): PlatformCallResult {
    if (call.call != "test.echo")
      return PlatformCallResult.Failure(
        PlatformError(PlatformErrorCode.UNSUPPORTED, "Unknown test call"),
      )
    val message =
      call.args["message"]
        ?: return PlatformCallResult.Failure(
          PlatformError(PlatformErrorCode.INVALID_ARGS, "message is required"),
        )
    wait((call.args["delayMs"] as? JsonPrimitive)?.longOrNull ?: 0)
    return PlatformCallResult.Success(message)
  }

  suspend fun tick(data: JsonObject) {
    mutableState.value = data
    mutableEvents.emit(PlatformEvent("test.tick", data))
  }

  override fun close() = Unit
}
