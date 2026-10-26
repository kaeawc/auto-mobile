package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.platform.InfiniteAnimationPolicy
import dev.jasonpearson.automobile.protocol.PrototypeDegradedEffect
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.coroutineContext

/** A source of frame timestamps in nanoseconds; null when no more frames will come. */
internal fun interface PrototypeFrameSource {
  suspend fun nextFrameNanos(): Long?
}

/**
 * The real Compose frame clock; suspends while the window is not drawing. An intentionally endless
 * loop, so it goes through the [InfiniteAnimationPolicy], which test clocks cancel instead of
 * waiting on (as Compose's own infinite animations do).
 */
internal object ComposeFrameSource : PrototypeFrameSource {
  override suspend fun nextFrameNanos(): Long {
    val policy = coroutineContext[InfiniteAnimationPolicy]
    return policy?.onInfiniteOperation { withFrameNanos { it } } ?: withFrameNanos { it }
  }
}

internal const val EFFECT_FRAME_BUDGET_NANOS = 32_000_000L
internal const val EFFECT_FRAME_BUDGET_FRAMES = 30

/**
 * The frame-budget guard (#15129): [frames] consecutive frames each longer than [thresholdNanos]
 * mean the effect is too heavy for this device. [onDegraded] fires exactly once, then the guard
 * stays degraded. One fast frame resets the run.
 */
internal class PrototypeEffectBudget(
  private val thresholdNanos: Long = EFFECT_FRAME_BUDGET_NANOS,
  private val frames: Int = EFFECT_FRAME_BUDGET_FRAMES,
  private val onDegraded: () -> Unit,
) {
  private var slowRun = 0
  var degraded = false
    private set

  fun record(frameNanos: Long) {
    if (degraded) return
    if (frameNanos > thresholdNanos) {
      slowRun++
      if (slowRun >= frames) {
        degraded = true
        onDegraded()
      }
    } else {
      slowRun = 0
    }
  }
}

/**
 * Drives an animated effect: [run] publishes the elapsed nanoseconds of the running animation on
 * every frame. While [motionEnabled] or [visible] is false the elapsed time does not advance, so a
 * frozen effect keeps its `phase` (screenshots stay deterministic) and resumes where it stopped.
 * When the [budget] degrades, [run] returns and the last published time stays.
 */
internal class PrototypeEffectClock(
  private val frames: PrototypeFrameSource,
  private val budget: PrototypeEffectBudget,
) {
  suspend fun run(
    motionEnabled: () -> Boolean,
    visible: () -> Boolean,
    startNanos: Long = 0L,
    publish: (Long) -> Unit,
  ) {
    var last: Long? = null
    var elapsed = startNanos
    while (!budget.degraded) {
      val now = frames.nextFrameNanos() ?: return
      val delta = last?.let { now - it } ?: 0L
      last = now
      if (!motionEnabled() || !visible()) continue
      elapsed += delta
      budget.record(delta)
      if (!budget.degraded) publish(elapsed)
    }
  }
}

private const val NANOS_PER_MILLI = 1_000_000.0

/**
 * Where an effect's cycle is: its authored [base] `phase` advanced by [elapsedNanos] of a loop that
 * lasts [periodMs]. Without `animate` the phase is the authored one, which is also what a frozen
 * effect shows.
 */
internal fun prototypeEffectPhase(base: Float, periodMs: Int?, elapsedNanos: Long): Float {
  if (periodMs == null) return base
  val cycles = base + elapsedNanos / (periodMs * NANOS_PER_MILLI)
  return (cycles - kotlin.math.floor(cycles)).toFloat()
}

/**
 * Effects a running prototype stopped animating because they blew the frame budget, reported on the
 * next `inspect_prototypes` (`degradedEffects`, reason `budget`). Written from composition, read by
 * the controller thread.
 */
@InternalAutoMobilePrototypeApi
class PrototypeEffectHealth {
  private val frozen = ConcurrentHashMap<String, PrototypeDegradedEffect>()

  internal fun markBudget(path: String, type: String) {
    frozen.putIfAbsent(path, PrototypeDegradedEffect(path, type, PROTOTYPE_DEGRADED_BUDGET))
  }

  fun snapshot(): List<PrototypeDegradedEffect> = frozen.values.sortedBy { it.path }

  internal fun clear(path: String) {
    frozen.remove(path)
  }
}
