package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.StartDeviceResult
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.time.Delayer
import dev.jasonpearson.automobile.desktop.core.time.RealDelayer
import dev.jasonpearson.automobile.desktop.core.workspace.wireName
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
   *
   * While the device's previous session is still finishing its cleanup the daemon refuses the start
   * as retryable (#10960); the real impl waits it out and reports that through
   * [onFinishingPreviousSession] (`true` when the wait begins, `false` when the start is retried).
   */
  suspend fun boot(
    device: PickerDevice,
    onFinishingPreviousSession: (Boolean) -> Unit = {},
  ): Result<String>
}

/**
 * Longest the picker waits out a previous session's cleanup: the recording-finalize cap plus slack.
 */
const val DEVICE_CLEANUP_WAIT_BUDGET_MS = 150_000L

private val LOG = LoggerFactory.getLogger("DeviceBootController")

/**
 * Real boot controller backed by the daemon [AutoMobileClient]. The picker's device id is the AVD
 * name (Android) or simulator id (iOS) taken from the device-images resource, so it is passed as
 * both the match `name` and `deviceId` — the daemon matcher accepts either.
 */
class RealDeviceBootController(
  private val client: AutoMobileClient,
  private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
  private val delayer: Delayer = RealDelayer,
  private val cleanupWaitBudgetMs: Long = DEVICE_CLEANUP_WAIT_BUDGET_MS,
) : DeviceBootController {
  /** Starts [device], waiting out `device_cleanup_in_progress` refusals within the budget. */
  private suspend fun startWaitingForCleanup(
    device: PickerDevice,
    onFinishingPreviousSession: (Boolean) -> Unit,
  ): StartDeviceResult {
    var waitedMs = 0L
    while (true) {
      val result =
        client.startDevice(
          name = device.name,
          platform = device.platform.wireName(),
          deviceId = device.id,
        )
      val retryAfterMs = result.cleanupRetryAfterMs
      if (result.success || retryAfterMs == null || waitedMs >= cleanupWaitBudgetMs) return result
      val waitMs = retryAfterMs.coerceIn(0L, cleanupWaitBudgetMs - waitedMs)
      LOG.info("${device.name} is finishing its previous session; retrying start in ${waitMs}ms")
      onFinishingPreviousSession(true)
      try {
        delayer.delay(waitMs)
      } finally {
        onFinishingPreviousSession(false)
      }
      waitedMs += maxOf(waitMs, 1L)
    }
  }

  override suspend fun boot(
    device: PickerDevice,
    onFinishingPreviousSession: (Boolean) -> Unit,
  ): Result<String> =
    withContext(ioDispatcher) {
      try {
        val result = startWaitingForCleanup(device, onFinishingPreviousSession)
        val runtimeId = result.resolvedDeviceId
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
                "Device booted but the daemon didn't report a runtime id; can't verify it",
              ),
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

  /** Wait notifications to replay to the caller before the boot proceeds (`true`, then `false`). */
  var finishingPreviousSessionWaits: Int = 0

  /** Runs after each wait notification, so a test can observe the state it produced. */
  var onFinishing: () -> Unit = {}

  override suspend fun boot(
    device: PickerDevice,
    onFinishingPreviousSession: (Boolean) -> Unit,
  ): Result<String> {
    bootRequests += device
    repeat(finishingPreviousSessionWaits) {
      onFinishingPreviousSession(true)
      onFinishing()
      onFinishingPreviousSession(false)
      onFinishing()
    }
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
