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
  /**
   * Boot [device]. On success returns the **runtime device id** the daemon assigned the started
   * device (e.g. `emulator-5556`) — the authoritative handle for auto-selecting it, which is not
   * the shut-down AVD id and must not be inferred from the display name (ambiguous for
   * identically-named devices). Returns a failure if the boot did not start.
   */
  suspend fun boot(device: PickerDevice): Result<String>
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
  override suspend fun boot(device: PickerDevice): Result<String> =
    withContext(ioDispatcher) {
      try {
        val result =
          client.startDevice(
            name = device.name,
            platform = device.platform.wireName(),
            deviceId = device.id,
          )
        val runtimeId = result.deviceId
        when {
          !result.success -> {
            val message = result.message ?: "Failed to boot ${device.name}"
            LOG.warn("startDevice reported failure for ${device.name}: $message")
            Result.failure(IllegalStateException(message))
          }
          runtimeId == null -> {
            // Reject rather than fabricate an id. The shut-down source id would fail
            // reloadAfterBoot's exact-id match against the real runtime serial, so a booted
            // device would read "Boot did not complete" and stay unselected; a failure surfaces
            // a retryable "Boot failed" affordance instead. Only older daemons omit deviceId.
            LOG.warn("startDevice succeeded for ${device.name} but reported no runtime deviceId")
            Result.failure(
              IllegalStateException(
                "Device booted but the daemon didn't report a runtime id; can't verify it"
              )
            )
          }
          else -> Result.success(runtimeId)
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
 * On success the returned runtime id is [result]'s value, or the device's own id when that value is
 * blank. [onSuccess] lets a test mutate its resource fake so the reload sees the device as booted.
 */
class FakeDeviceBootController : DeviceBootController {
  val bootRequests: MutableList<PickerDevice> = mutableListOf()
  var result: Result<String> = Result.success("")
  var autoComplete: Boolean = true
  var onSuccess: (PickerDevice) -> Unit = {}
  private var gate: CompletableDeferred<Unit>? = null

  override suspend fun boot(device: PickerDevice): Result<String> {
    bootRequests += device
    if (!autoComplete) {
      val deferred = CompletableDeferred<Unit>()
      gate = deferred
      deferred.await()
    }
    val current = result
    val runtimeId = current.getOrNull()
    return if (current.isSuccess) {
      onSuccess(device)
      Result.success(if (runtimeId.isNullOrEmpty()) device.id else runtimeId)
    } else {
      current
    }
  }

  /** Release a boot that was held open by [autoComplete] = false. */
  fun complete() {
    gate?.complete(Unit)
  }
}
