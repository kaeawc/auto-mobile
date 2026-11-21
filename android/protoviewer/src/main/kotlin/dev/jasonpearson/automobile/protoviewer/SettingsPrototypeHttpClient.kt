package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpClient
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpRequest
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeImageState
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRemoteImageLoader
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRemoteImageProvider
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
) : PrototypeHttpClient, PrototypeRemoteImageProvider {
  private val allowed by lazy(allowedClient)

  var allowedImages: () -> PrototypeRemoteImageLoader? = { null }
  override val remoteImages = PrototypeRemoteImageLoader { url, target ->
    withConsent({ PrototypeImageState.Missing }) {
      allowedImages()?.load(url, target) ?: PrototypeImageState.Missing
    }
  }

  override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse =
    withConsent({ DeniedPrototypeHttpClient.execute(request) }) { allowed.execute(request) }

  private suspend fun <T> withConsent(denied: suspend () -> T, call: suspend () -> T): T =
    coroutineScope {
      val epoch = settings.networkRevocations.value
      if (!settings.allowNetwork.value) return@coroutineScope denied()
      val revoked =
        async(start = CoroutineStart.UNDISPATCHED) {
          settings.networkRevocations.first { it != epoch }
        }
      // Transport errors raised by revocation-time cancellation must not escape as host details.
      val response = async { runTransport(call) }
      try {
        select {
          revoked.onAwait { denied() }
          response.onAwait {
            if (settings.allowNetwork.value && settings.networkRevocations.value == epoch)
              it.getOrThrow()
            else denied()
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
  private suspend fun <T> runTransport(call: suspend () -> T): Result<T> =
    try {
      Result.success(call())
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Result.failure(error)
    }
}
