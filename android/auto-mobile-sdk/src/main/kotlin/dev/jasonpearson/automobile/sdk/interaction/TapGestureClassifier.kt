package dev.jasonpearson.automobile.sdk.interaction

/**
 * Tap decisions using caller-supplied timestamps and raw coordinates.
 *
 * DOWN stores the gesture's position and time. UP consumes the previous DOWN; ignored events retain
 * it.
 */
internal class TapGestureClassifier(private val slopPx: Int, private val timeoutMs: Long) {

  private var downX = 0f
  private var downY = 0f
  private var downTime = 0L
  private var hasDown = false

  internal fun classify(action: Action, x: Float, y: Float, nowMs: Long): Result =
    when (action) {
      Action.DOWN -> {
        downX = x
        downY = y
        downTime = nowMs
        hasDown = true
        Result.NoDecision
      }
      Action.UP -> {
        val hadDown = hasDown
        hasDown = false
        val duration = nowMs - downTime
        val dx = x - downX
        val dy = y - downY
        if (
          hadDown && dx * dx + dy * dy < slopPx * slopPx && duration >= 0 && duration < timeoutMs
        ) {
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
