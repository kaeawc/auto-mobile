package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpClient
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpRequest
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse

/** Select on every execution, rather than capturing consent when the viewer opens. */
class SettingsPrototypeHttpClient(
  private val settings: SettingsStore,
  allowedClient: () -> PrototypeHttpClient,
) : PrototypeHttpClient {
  private val allowed by lazy(allowedClient)

  override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse =
    if (settings.allowNetwork.value) allowed.execute(request)
    else DeniedPrototypeHttpClient.execute(request)
}
