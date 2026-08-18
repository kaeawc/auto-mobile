package dev.jasonpearson.automobile.desktop.core.update

import dev.hydraulic.conveyor.control.SoftwareUpdateController
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory

private val LOG = LoggerFactory.getLogger("ConveyorSoftwareUpdateGateway")

/**
 * The production [SoftwareUpdateGateway], backed by Conveyor's [SoftwareUpdateController]. Only
 * constructible when the app runs inside a Conveyor package — [createOrNull] returns `null`
 * otherwise (development, jpackage builds, tests), so DI can fall back to the GitHub checker.
 */
class ConveyorSoftwareUpdateGateway
private constructor(private val controller: SoftwareUpdateController) : SoftwareUpdateGateway {

  override fun probe(): UpdateProbe {
    val repository =
      try {
        controller.currentVersionFromRepository
      } catch (error: SoftwareUpdateController.UpdateCheckException) {
        throw UpdateProbeException(error.message ?: "Update repository check failed", error)
      }
    // No repository version means nothing newer is published (or the repo has no releases yet).
    if (repository == null) return UpdateProbe.UpToDate

    // A null current version (unknown packaged version) is treated as "older than anything the
    // repository advertises", so the update surfaces rather than being silently swallowed.
    val current = controller.currentVersion
    val isNewer = current == null || current < repository
    return if (isNewer) UpdateProbe.Available(repository.version) else UpdateProbe.UpToDate
  }

  override fun canApply(): Boolean =
    controller.canTriggerUpdateCheckUI() == SoftwareUpdateController.Availability.AVAILABLE

  override fun apply() {
    controller.triggerUpdateCheckUI()
  }

  companion object {
    /**
     * A gateway when the app is running inside a Conveyor package, else `null`. The underlying
     * [SoftwareUpdateController.getInstance] is `null` in development, jpackage builds and tests.
     */
    fun createOrNull(): SoftwareUpdateGateway? {
      val controller = SoftwareUpdateController.getInstance()
      if (controller == null) {
        LOG.debug("Not running inside a Conveyor package; SoftwareUpdateController unavailable.")
        return null
      }
      return ConveyorSoftwareUpdateGateway(controller)
    }
  }
}
