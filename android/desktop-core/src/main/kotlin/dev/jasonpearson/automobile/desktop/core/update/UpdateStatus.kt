package dev.jasonpearson.automobile.desktop.core.update

/**
 * A downloadable installer attached to a GitHub release, resolved for the running OS. [downloadUrl]
 * is the `browser_download_url`; applying it (download + launch) is a later item — this item only
 * identifies which asset would be used.
 */
data class ReleaseAsset(val name: String, val downloadUrl: String, val sizeBytes: Long)

/**
 * The desktop app's update state, surfaced as a `StateFlow` so the UI can render an "update ready"
 * affordance without performing any network work itself.
 */
sealed interface UpdateStatus {
  /** No check has run yet. */
  data object Idle : UpdateStatus

  /** A check is in flight. */
  data object Checking : UpdateStatus

  /**
   * The running build is current (or nothing installable applies to this OS / this is a dev run).
   */
  data object UpToDate : UpdateStatus

  /**
   * A newer release is available. [asset] is the OS-specific installer for the GitHub-Releases
   * checker ([RealUpdateController]); it is `null` for a Conveyor-managed update
   * ([ConveyorUpdateController]), which owns the download and exposes no per-asset URL.
   * [releaseNotesUrl] is likewise GitHub-only. Whether the app can apply the update in place is
   * answered by [UpdateController.canApplyUpdate], not carried here.
   */
  data class UpdateAvailable(
    val version: String,
    val asset: ReleaseAsset? = null,
    val releaseNotesUrl: String? = null,
  ) : UpdateStatus

  /** The check could not complete (network, rate limit, malformed response). */
  data class Failed(val reason: String) : UpdateStatus
}
