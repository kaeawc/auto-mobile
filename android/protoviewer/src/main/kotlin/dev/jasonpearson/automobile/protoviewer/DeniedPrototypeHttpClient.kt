package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.protocol.PrototypeRequestError
import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import dev.jasonpearson.automobile.prototype.PrototypeHttpClient
import dev.jasonpearson.automobile.prototype.PrototypeHttpRequest

object DeniedPrototypeHttpClient : PrototypeHttpClient {
  override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse =
    PrototypeRequestResponse.Failed(
      PrototypeRequestError(
        PrototypeRequestErrorCode.BLOCKED_DESTINATION,
        "Network is disabled for library prototypes.",
      ),
    )
}
