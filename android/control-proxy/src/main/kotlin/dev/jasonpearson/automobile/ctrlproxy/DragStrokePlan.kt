package dev.jasonpearson.automobile.ctrlproxy

import kotlin.math.abs

/** A finite, single-pointer drag: press, travel, then release at the requested target. */
internal fun dragStrokePlan(
  from: GesturePoint,
  to: GesturePoint,
  pressDurationMs: Long,
  dragDurationMs: Long,
  holdDurationMs: Long,
): List<GestureSegment> {
  val phases = buildList {
    if (pressDurationMs > 0) add(from to pressDurationMs)
    add(to to dragDurationMs.coerceAtLeast(1L))
    if (holdDurationMs > 0) add(to to holdDurationMs)
  }
  val dx = to.x - from.x
  val dy = to.y - from.y
  val nudge =
    when {
      abs(dx) > abs(dy) -> GesturePoint(if (dx < 0) -1f else 1f, 0f)
      abs(dy) > abs(dx) -> GesturePoint(0f, if (dy < 0) -1f else 1f)
      else -> GesturePoint(1f, 0f)
    }
  var current = from
  return phases.mapIndexed { index, (target, duration) ->
    val start = current
    val isHold = start == target
    val willContinue = index < phases.lastIndex
    // A stationary continued stroke can complete immediately because it emits no timed MOVE or
    // UP. One pixel changes the rounded position below touch slop, preserving the full duration.
    val end =
      if (isHold && willContinue) GesturePoint(start.x + nudge.x, start.y + nudge.y) else target
    current = end
    GestureSegment(
      from = start,
      to = end,
      durationMs = duration,
      willContinue = willContinue,
      isInitial = index == 0,
      isHold = isHold,
    )
  }
}
