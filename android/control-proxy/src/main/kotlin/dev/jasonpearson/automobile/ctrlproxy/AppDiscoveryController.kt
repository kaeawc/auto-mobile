package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.KeystoreDiscoveryResult
import dev.jasonpearson.automobile.protocol.KeystoreDiscoveryState
import dev.jasonpearson.automobile.protocol.SdkCapabilitiesResult
import dev.jasonpearson.automobile.protocol.SdkCapabilitiesState

/**
 * Answers `discover_keystore` and `get_sdk_capabilities`: what the target app's debug bridge can
 * do, read off the request queue and returned as a correlated result.
 */
internal class AppDiscoveryController(
  private val source: Source,
  private val asyncActionRunner: AsyncActionRunner,
  private val resultSender: ResultSender,
  private val timeProvider: TimeProvider,
) {
  /** Reads the target app's bridge providers. */
  interface Source {
    fun keystore(packageName: String): KeystoreDiscoveryState

    /** [userId] targets another Android user's instance of the app; null is the service's own. */
    fun sdkCapabilities(packageName: String, userId: Int?): SdkCapabilitiesState
  }

  fun discoverKeystore(requestId: String?, packageName: String) {
    asyncActionRunner.launch(requestId, "discover_keystore") {
      val state = source.keystore(packageName)
      // A capability snapshot carries no request timing.
      resultSender.send(requestId, "keystore_discovery", attachPerf = false) { _ ->
        KeystoreDiscoveryResult(
          timestamp = timeProvider.currentTimeMillis(),
          requestId = requestId,
          state = state,
        )
      }
    }
  }

  fun discoverSdkCapabilities(requestId: String?, packageName: String, userId: Int?) {
    asyncActionRunner.launch(requestId, "get_sdk_capabilities") {
      val state = source.sdkCapabilities(packageName, userId)
      resultSender.send(requestId, "sdk_capabilities", attachPerf = false) { _ ->
        SdkCapabilitiesResult(
          timestamp = timeProvider.currentTimeMillis(),
          requestId = requestId,
          state = state,
        )
      }
    }
  }
}
