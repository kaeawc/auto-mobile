package dev.jasonpearson.automobile.desktop.core.performance

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.daemon.PerformanceStreamUpdate

/**
 * The latest live performance values the shell chrome shows while the Performance panel is
 * collapsed: frame rate and memory. Null until the observation stream sends an update, and again
 * after the stream disconnects or the active device's connection is lost.
 */
class CollapsedPerformanceSummaryState {
  var fps by mutableStateOf<Float?>(null)
    private set

  var memoryMb by mutableStateOf<Float?>(null)
    private set

  fun apply(update: PerformanceStreamUpdate) {
    fps = update.fps
    memoryMb = update.memoryUsageMb
  }

  fun clear() {
    fps = null
    memoryMb = null
  }
}
