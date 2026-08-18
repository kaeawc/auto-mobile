package dev.jasonpearson.automobile.desktop.core.update

import kotlinx.coroutines.flow.StateFlow

/**
 * Observes whether a newer desktop release is available and, where the packaging supports it,
 * applies it. The UI collects [status]; nothing checks automatically — a caller (the app shell, a
 * manual "check now" action) invokes [checkForUpdate].
 *
 * Two implementations sit behind this seam: [RealUpdateController] checks GitHub Releases and
 * cannot self-apply, while [ConveyorUpdateController] uses Conveyor's control API to both check and
 * apply. DI picks the Conveyor one only when the app runs inside a Conveyor package (#5227, PR-C2).
 */
interface UpdateController {
  /** Current update state. Starts at [UpdateStatus.Idle] until the first [checkForUpdate]. */
  val status: StateFlow<UpdateStatus>

  /**
   * Runs one update check, transitioning [status]. A release-fetch failure transitions [status] to
   * [UpdateStatus.Failed] rather than throwing; coroutine cancellation propagates to the caller,
   * leaving [status] at its prior stable value.
   */
  suspend fun checkForUpdate()

  /**
   * Whether [applyUpdate] can install an update in place. `false` for the GitHub-Releases checker
   * (it only surfaces the release) and on platforms Conveyor can't trigger from the app (Linux
   * updates flow through apt). The UI enables its "Install & restart" action on this.
   */
  fun canApplyUpdate(): Boolean

  /**
   * Applies the available update — download, install, restart — handing off to the platform
   * updater. The app process is expected to exit as part of this, so callers must save state first.
   * A no-op when [canApplyUpdate] is `false`. Performs I/O; call off the UI thread.
   */
  suspend fun applyUpdate()
}
