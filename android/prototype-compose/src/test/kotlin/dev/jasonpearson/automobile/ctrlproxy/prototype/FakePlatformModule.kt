package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.prototype.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.JsonObject

class FakePlatformModule : PrototypePlatformModule {
  override val name = "test"
  override val capability = "prototype_platform_test_v1"
  var available: PlatformAvailability = PlatformAvailability.Ready

  override fun availability() = available

  val calls = mutableListOf<PlatformCall>()
  var execute: suspend (PlatformCall) -> PlatformCallResult = {
    PlatformCallResult.Success(it.args.getValue("message"))
  }

  override suspend fun call(call: PlatformCall): PlatformCallResult {
    calls += call
    return execute(call)
  }

  override val events = MutableSharedFlow<PlatformEvent>()
  override val state = MutableStateFlow(JsonObject(emptyMap()))
  var closed = false

  override fun close() {
    closed = true
  }
}
