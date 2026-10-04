package dev.jasonpearson.automobile.ctrlproxy

/**
 * A finite, single-pointer drag: press, travel, then release at the requested target. The press is
 * a stationary stroke that only puts the pointer down; [DragStrokeSession] holds it for the planned
 * time.
 */
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
  var current = from
  return phases.mapIndexed { index, (target, duration) ->
    val start = current
    current = target
    GestureSegment(
      from = start,
      to = target,
      durationMs = duration,
      willContinue = index < phases.lastIndex,
      isInitial = index == 0,
      isHold = start == target,
    )
  }
}
