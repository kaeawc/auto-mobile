package dev.jasonpearson.automobile.desktop.core.update

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

private val LOG = LoggerFactory.getLogger("ConveyorUpdateController")

/**
 * Drives the update affordance from Conveyor's control API via a [SoftwareUpdateGateway]. DI
 * selects this over [RealUpdateController] only when the app runs inside a Conveyor package. Purely
 * reactive: no network work until [checkForUpdate] is called, and never on construction.
 *
 * The probe runs on [Dispatchers.IO] (it performs network I/O); [applyUpdate] hands off to
 * Conveyor, which downloads, installs and restarts — so the app process is expected to exit.
 */
class ConveyorUpdateController(private val gateway: SoftwareUpdateGateway) : UpdateController {

  private val mutableStatus = MutableStateFlow<UpdateStatus>(UpdateStatus.Idle)
  override val status: StateFlow<UpdateStatus> = mutableStatus.asStateFlow()

  // Serializes checks so overlapping callers (a startup check racing a manual one) never interleave
  // their status writes — the previous-state capture below is only correct with one check in
  // flight.
  private val checkMutex = Mutex()

  override suspend fun checkForUpdate(): Unit = checkMutex.withLock {
    // Captured so a cancelled check restores the last stable state rather than pinning the shared
    // singleton StateFlow at Checking for every collector.
    val previousStatus = mutableStatus.value
    mutableStatus.value = UpdateStatus.Checking
    val probe =
      try {
        withContext(Dispatchers.IO) { gateway.probe() }
      } catch (cancellation: CancellationException) {
        mutableStatus.value = previousStatus
        throw cancellation
      } catch (error: Exception) {
        // Typed failure surfaced to the UI; the check is best-effort and must never crash the app.
        LOG.warn("Conveyor update check failed: ${error.message}", error)
        mutableStatus.value = UpdateStatus.Failed(error.message ?: "Update check failed")
        return
      }

    mutableStatus.value =
      when (probe) {
        is UpdateProbe.UpToDate -> UpdateStatus.UpToDate
        // Conveyor owns the download, so there is no per-asset URL or release-notes link to carry.
        is UpdateProbe.Available -> UpdateStatus.UpdateAvailable(version = probe.version)
      }
  }

  override fun canApplyUpdate(): Boolean = gateway.canApply()

  override suspend fun applyUpdate() {
    // Conveyor blocks while it hands off to the platform updater and tears the app down; keep it
    // off
    // the UI thread. Guarded by canApplyUpdate() at the call site, but harmless if the gateway is
    // asked when unsupported.
    withContext(Dispatchers.IO) { gateway.apply() }
  }
}
