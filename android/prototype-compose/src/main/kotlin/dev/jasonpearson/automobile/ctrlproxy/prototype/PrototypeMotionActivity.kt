package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow

/**
 * What the host reads off the prototype window while it animates (#15114): [active] counts the
 * animations that will settle (fades, slides, style animations, page scrolls) and [loops] counts
 * the intentional infinite ones (shimmer). `observe(waitFor: stable)` waits for [active] to reach
 * zero and ignores [loops].
 */
@InternalAutoMobilePrototypeApi
data class PrototypeMotionState(val active: Int, val loops: Int) {
  companion object {
    val Settled = PrototypeMotionState(0, 0)
  }
}

/**
 * Counts the running animations of one prototype window. Each animation site reports under its own
 * identity, so a site that reports twice is counted once and one that leaves composition while
 * running is released by [ReportPrototypeMotion]. Reported from the main thread, read from the
 * accessibility capture thread, so every access is synchronized.
 */
@InternalAutoMobilePrototypeApi
class PrototypeMotionActivity {
  private val settling = HashSet<Any>()
  private val looping = HashSet<Any>()

  /**
   * Marks [owner] as running (or not). A [loop] owner is counted in [PrototypeMotionState.loops].
   */
  fun report(owner: Any, running: Boolean, loop: Boolean = false) {
    synchronized(this) {
      val set = if (loop) looping else settling
      if (running) set.add(owner) else set.remove(owner)
    }
  }

  /** Drops [owner] from both counts. */
  fun release(owner: Any) {
    synchronized(this) {
      settling.remove(owner)
      looping.remove(owner)
    }
  }

  fun snapshot(): PrototypeMotionState =
    synchronized(this) { PrototypeMotionState(settling.size, looping.size) }
}

/**
 * The window's motion counter; null (previews, direct [PrototypeSpecContent] callers) counts none.
 */
internal val LocalPrototypeMotionActivity = compositionLocalOf<PrototypeMotionActivity?> { null }

/**
 * Reports an animation site to the window's [PrototypeMotionActivity] while [running] is true, and
 * releases it when the site leaves composition. [running] is read in a snapshot flow rather than in
 * composition, so reading an animated value there costs no recomposition per frame.
 */
@Composable
internal fun ReportPrototypeMotion(loop: Boolean = false, running: () -> Boolean) {
  val activity = LocalPrototypeMotionActivity.current ?: return
  val owner = remember { Any() }
  val current = rememberUpdatedState(running)
  LaunchedEffect(activity, owner, loop) {
    snapshotFlow { current.value() }.collect { activity.report(owner, it, loop) }
  }
  DisposableEffect(activity, owner, loop) { onDispose { activity.release(owner) } }
}
