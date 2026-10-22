package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpClient
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpRequest
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

internal class FakeSettingsStore : SettingsStore {
  private val network = MutableStateFlow(false)
  override val allowNetwork = network.asStateFlow()
  private val revocations = MutableStateFlow(0L)
  override val networkRevocations = revocations.asStateFlow()

  override fun setAllowNetwork(enabled: Boolean) {
    if (!enabled && network.value) revocations.value++
    network.value = enabled
  }
}

internal class FakeLocalNetworkPermission(var granted: Boolean = false) : LocalNetworkPermission {
  var requests = 0
  var result: (Boolean) -> Unit = {}

  override fun request() {
    requests++
    result(granted)
  }
}

internal class FakePrototypeHttpClient : PrototypeHttpClient {
  val requests = mutableListOf<PrototypeHttpRequest>()
  val response = PrototypeRequestResponse.Received(200, emptyMap(), null, 0)

  override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse {
    requests += request
    return response
  }
}
