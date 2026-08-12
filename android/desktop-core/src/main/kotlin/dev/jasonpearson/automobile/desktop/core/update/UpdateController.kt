package dev.jasonpearson.automobile.desktop.core.update

import kotlinx.coroutines.flow.StateFlow

/**
 * Observes whether a newer desktop release is available. The UI collects [status]; nothing checks
 * automatically — a caller (the app shell, a manual "check now" action) invokes [checkForUpdate].
 * This item performs the *check* only; downloading and installing an update is a later item.
 */
interface UpdateController {
  /** Current update state. Starts at [UpdateStatus.Idle] until the first [checkForUpdate]. */
  val status: StateFlow<UpdateStatus>

  /**
   * Runs one update check, transitioning [status]. Never throws — failures land in
   * [UpdateStatus.Failed].
   */
  suspend fun checkForUpdate()
}
