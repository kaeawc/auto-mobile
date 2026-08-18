package dev.jasonpearson.automobile.desktop.core.update

/** The result of probing the update repository for a newer build. */
sealed interface UpdateProbe {
  /** The running build is the latest the repository offers. */
  data object UpToDate : UpdateProbe

  /** A newer build is available; [version] is its human-readable version string. */
  data class Available(val version: String) : UpdateProbe
}

/**
 * Raised when an [SoftwareUpdateGateway.probe] cannot complete (network error, repository fault).
 */
class UpdateProbeException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * A narrow, fakeable seam over Conveyor's `SoftwareUpdateController`. Isolating the three
 * operations the controller needs keeps [ConveyorUpdateController] unit-testable without a real
 * Conveyor package (the underlying `getInstance()` returns `null` outside one).
 *
 * The production implementation is [ConveyorSoftwareUpdateGateway]; its `createOrNull()` returns
 * `null` when the app isn't running inside a Conveyor package, which is how DI decides to fall back
 * to the GitHub-Releases checker.
 */
interface SoftwareUpdateGateway {
  /**
   * Compares the packaged version against the repository's latest. Performs network I/O — call it
   * off the UI thread. Throws [UpdateProbeException] if the repository can't be reached or read.
   */
  fun probe(): UpdateProbe

  /**
   * Whether [apply] can install an update in place on this OS and package type. `false` where
   * Conveyor can't trigger an update from the app (notably Linux, where updates flow through apt).
   */
  fun canApply(): Boolean

  /**
   * Hands off to Conveyor to download, install and restart into the new version. The app process is
   * expected to exit; save state before calling. A no-op guarded by [canApply] at the call site.
   */
  fun apply()
}
