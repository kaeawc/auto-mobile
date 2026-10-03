package dev.jasonpearson.automobile.sdk.interaction

/**
 * Tap decisions using caller-supplied wall-clock timestamps and raw coordinates.
 *
 * Only DOWN updates state. UP and ignored events deliberately retain the previous DOWN, matching
 * the window callback's original behavior.
 */
internal class TapGestureClassifier(private val slopPx: Int, private val timeoutMs: Long) {

  private var downX = 0f
  private var downY = 0f
  private var downTime = 0L

  internal fun classify(action: Action, x: Float, y: Float, nowMs: Long): Result =
    when (action) {
      Action.DOWN -> {
        downX = x
        downY = y
        downTime = nowMs
        Result.NoDecision
      }
      Action.UP -> {
        val duration = nowMs - downTime
        val dx = x - downX
        val dy = y - downY
        if (dx * dx + dy * dy < slopPx * slopPx && duration < timeoutMs) {
          Result.Tap(x, y, duration)
        } else {
          Result.NotTap
        }
      }
      Action.OTHER -> Result.NoDecision
    }

  internal enum class Action {
    DOWN,
    UP,
    OTHER,
  }

  internal sealed interface Result {
    data class Tap(val x: Float, val y: Float, val durationMs: Long) : Result

    data object NotTap : Result

    data object NoDecision : Result
  }
}
