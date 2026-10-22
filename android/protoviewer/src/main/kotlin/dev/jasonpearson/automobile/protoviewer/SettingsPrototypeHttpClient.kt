package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpClient
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpRequest
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.selects.select

/** Consent belongs to one revocation epoch, never to the lifetime of the viewer or transport. */
class SettingsPrototypeHttpClient(
  private val settings: SettingsStore,
  allowedClient: () -> PrototypeHttpClient,
) : PrototypeHttpClient {
  private val allowed by lazy(allowedClient)

  override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse =
    coroutineScope {
      val epoch = settings.networkRevocations.value
      if (!settings.allowNetwork.value)
        return@coroutineScope DeniedPrototypeHttpClient.execute(request)
      val revoked =
        async(start = CoroutineStart.UNDISPATCHED) {
          settings.networkRevocations.first { it != epoch }
        }
      // Transport errors raised by revocation-time cancellation must not escape as host details.
      val response = async { runTransport(request) }
      try {
        select {
          revoked.onAwait { DeniedPrototypeHttpClient.execute(request) }
          response.onAwait {
            if (settings.allowNetwork.value && settings.networkRevocations.value == epoch)
              it.getOrThrow()
            else DeniedPrototypeHttpClient.execute(request)
          }
        }
      } finally {
        revoked.cancel()
        response.cancel()
      }
    }

  @Suppress(
    "TooGenericExceptionCaught",
  ) // Any transport failure is deferred until consent is rechecked.
  private suspend fun runTransport(
    request: PrototypeHttpRequest,
  ): Result<PrototypeRequestResponse> =
    try {
      Result.success(allowed.execute(request))
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Result.failure(error)
    }
}
