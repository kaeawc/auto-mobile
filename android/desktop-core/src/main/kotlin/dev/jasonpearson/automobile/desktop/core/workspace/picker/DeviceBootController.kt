package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.workspace.Platform
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Boot seam for the device picker. Clicking a shut-down card asks this controller to bring the
 * device up (via the `startDevice` MCP tool in the real impl). Kept as a narrow interface so the
 * [DevicePickerViewModel] is unit-testable without a running daemon.
 */
interface DeviceBootController {
  /** Boot [device]. Returns success once the daemon reports the device started, else a failure. */
  suspend fun boot(device: PickerDevice): Result<Unit>
}

private val LOG = LoggerFactory.getLogger("DeviceBootController")

private fun Platform.wireName(): String = if (this == Platform.Ios) "ios" else "android"

/**
 * Real boot controller backed by the daemon [AutoMobileClient]. The picker's device id is the AVD
 * name (Android) or simulator id (iOS) taken from the device-images resource, so it is passed as
 * both the match `name` and `deviceId` — the daemon matcher accepts either.
 */
class RealDeviceBootController(
  private val client: AutoMobileClient,
  private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : DeviceBootController {
  override suspend fun boot(device: PickerDevice): Result<Unit> =
    withContext(ioDispatcher) {
      try {
        val result =
          client.startDevice(
            name = device.name,
            platform = device.platform.wireName(),
            deviceId = device.id,
          )
        if (result.success) {
          Result.success(Unit)
        } else {
          val message = result.message ?: "Failed to boot ${device.name}"
          LOG.warn("startDevice reported failure for ${device.name}: $message")
          Result.failure(IllegalStateException(message))
        }
      } catch (c: CancellationException) {
        // Never swallow structured-concurrency cancellation — let it propagate.
        throw c
      } catch (e: Exception) {
        LOG.warn("startDevice threw for ${device.name}: ${e.message}", e)
        Result.failure(e)
      }
    }
}

/**
 * Test fake. By default a boot completes immediately with [result]; set [autoComplete] to false to
 * hold the boot open (observe the transient "booting" state) and release it later with [complete].
 * [onSuccess] lets a test mutate its resource fake so the reload sees the device as booted.
 */
class FakeDeviceBootController : DeviceBootController {
  val bootRequests: MutableList<PickerDevice> = mutableListOf()
  var result: Result<Unit> = Result.success(Unit)
  var autoComplete: Boolean = true
  var onSuccess: (PickerDevice) -> Unit = {}
  private var gate: CompletableDeferred<Unit>? = null

  override suspend fun boot(device: PickerDevice): Result<Unit> {
    bootRequests += device
    if (!autoComplete) {
      val deferred = CompletableDeferred<Unit>()
      gate = deferred
      deferred.await()
    }
    if (result.isSuccess) {
      onSuccess(device)
    }
    return result
  }

  /** Release a boot that was held open by [autoComplete] = false. */
  fun complete() {
    gate?.complete(Unit)
  }
}
