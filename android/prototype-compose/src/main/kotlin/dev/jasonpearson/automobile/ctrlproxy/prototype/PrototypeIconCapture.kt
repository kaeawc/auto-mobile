package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Capture owns the hold through its finally, including failures and cancellation. */
@InternalAutoMobilePrototypeApi
object PrototypeIconCapture {
  private val mutex = Mutex()
  private val loops = HashSet<Any>()

  @Synchronized
  fun registerLoop(owner: Any) {
    loops.add(owner)
  }

  @Synchronized
  fun releaseLoop(owner: Any) {
    loops.remove(owner)
  }

  @Synchronized private fun hasLoops(): Boolean = loops.isNotEmpty()

  private val mutableHeld = MutableStateFlow(false)
  val held = mutableHeld.asStateFlow()

  suspend fun <T> atRest(
    frames: PrototypeFrameWaiter = ChoreographerPrototypeFrameWaiter,
    capture: suspend () -> T,
  ): T = mutex.withLock {
    if (!hasLoops()) return@withLock capture()
    mutableHeld.value = true
    try {
      frames.awaitFrames(2)
      capture()
    } finally {
      mutableHeld.value = false
    }
  }
}

@Composable
internal fun TrackPrototypeIconCapture(enabled: Boolean) {
  val owner = remember { Any() }
  DisposableEffect(enabled) {
    if (enabled) PrototypeIconCapture.registerLoop(owner)
    onDispose { PrototypeIconCapture.releaseLoop(owner) }
  }
}
