package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamHub
import dev.jasonpearson.automobile.desktop.core.daemon.awaitFreshHierarchy
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull

private val LOG = LoggerFactory.getLogger("ForegroundAppResolver")

/**
 * Resolves the package of a device's current foreground app. Needed because `changeLocalization`
 * requires an `appId` on Android (iOS is device-wide) — the Locale control targets whatever app is
 * on screen. A seam so the executor's locale logic can be pinned with a fake.
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
 * Real resolver: requests one observation and reads the `packageName` (the on-screen app) of the
 * first hierarchy captured after the request. When [hub] has a lease on [deviceId] (a pane showing
 * that device), the lookup takes a lease on that shared stream and opens no socket (#17027);
 * otherwise it opens a per-device stream from [observationStreamFactory]. Either way the stream is
 * released afterwards. Bounded by a timeout so a gone device can't hang the caller.
 */
class ObservationForegroundAppResolver(
  sessionUuidProvider: () -> String? = { null },
  private val observationStreamFactory: (String) -> ObservationStream = {
    ObservationStreamClient(sessionUuidProvider = sessionUuidProvider)
  },
  private val hub: () -> ObservationStreamHub? = { null },
  private val timeoutMs: Long = 10_000L,
) : ForegroundAppResolver {
  override suspend fun resolve(deviceId: String): String? {
    val stream = hubStream(deviceId) ?: observationStreamFactory(deviceId)
    return try {
      stream.connect(deviceId)
      withTimeoutOrNull(timeoutMs) {
        stream.awaitFreshHierarchy(deviceId) { !it.packageName.isNullOrBlank() }.packageName
      }
    } catch (cancellation: CancellationException) {
      throw cancellation
    } catch (error: IOException) {
      LOG.warn("Foreground-app resolve failed for $deviceId: ${error.message}", error)
      null
    } finally {
      stream.dispose()
    }
  }

  /**
   * A lease on the hub stream a pane already holds for [deviceId], or null. The lookup is keyed by
   * serial only, so it joins the device's live key (with its epoch) rather than opening a new one.
   */
  private fun hubStream(deviceId: String): ObservationStream? {
    val streams = hub() ?: return null
    val live = streams.observationSubscriptions.value.keys.filter { it.deviceId == deviceId }
    val key = live.firstOrNull { it.deviceSessionUuid != null } ?: live.firstOrNull() ?: return null
    return streams.observationStream(key)
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
