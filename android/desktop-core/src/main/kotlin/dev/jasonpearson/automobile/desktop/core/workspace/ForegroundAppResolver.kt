package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

private val LOG = LoggerFactory.getLogger("ForegroundAppResolver")

/**
 * Resolves the package of a device's current foreground app. Needed because `changeLocalization`
 * requires an `appId` on Android (iOS is device-wide) — the Locale control targets whatever app is
 * on screen. A seam so the executor's locale logic can be pinned with a fake; the real
 * implementation opens an observation stream and is untested IO.
 */
interface ForegroundAppResolver {
  /** The foreground app package for [deviceId], or null if it can't be determined. */
  suspend fun resolve(deviceId: String): String?
}

/** Resolver that never determines an app (default for hosts/tests that don't need locale). */
object NoOpForegroundAppResolver : ForegroundAppResolver {
  override suspend fun resolve(deviceId: String): String? = null
}

/**
 * Real resolver: opens a per-device [ObservationStream], requests one observation, and reads the
 * first hierarchy frame's `packageName` (the on-screen app), then disposes. Bounded by a timeout so
 * a gone device can't hang the caller. Untested IO seam.
 */
class ObservationForegroundAppResolver(
  private val observationStreamFactory: (String) -> ObservationStream = {
    ObservationStreamClient()
  },
  private val timeoutMs: Long = 10_000L,
) : ForegroundAppResolver {
  override suspend fun resolve(deviceId: String): String? {
    val stream = observationStreamFactory(deviceId)
    return try {
      stream.connect(deviceId)
      stream.requestObservation(deviceId)
      withTimeoutOrNull(timeoutMs) {
        stream.hierarchyUpdates.first { !it.packageName.isNullOrBlank() }.packageName
      }
    } catch (cancellation: CancellationException) {
      throw cancellation
    } catch (error: Exception) {
      LOG.warn("Foreground-app resolve failed for $deviceId: ${error.message}", error)
      null
    } finally {
      stream.dispose()
    }
  }
}

/** Records the requested device ids and returns a configured [appId]. */
class FakeForegroundAppResolver(var appId: String? = "com.example.app") : ForegroundAppResolver {
  val requestedDeviceIds: MutableList<String> = mutableListOf()

  override suspend fun resolve(deviceId: String): String? {
    requestedDeviceIds += deviceId
    return appId
  }
}
