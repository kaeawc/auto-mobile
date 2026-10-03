package dev.jasonpearson.automobile.ctrlproxy

/** A finite, single-pointer drag: stationary press, travel, then stationary release. */
internal fun dragStrokePlan(
  from: GesturePoint,
  to: GesturePoint,
  pressDurationMs: Long,
  dragDurationMs: Long,
  holdDurationMs: Long,
): List<GestureSegment> {
  val phases = buildList {
    if (pressDurationMs > 0) add(Triple(from, from, pressDurationMs))
    add(Triple(from, to, dragDurationMs.coerceAtLeast(1L)))
    if (holdDurationMs > 0) add(Triple(to, to, holdDurationMs))
  }
  return phases.mapIndexed { index, (start, end, duration) ->
    GestureSegment(
      from = start,
      to = end,
      durationMs = duration,
      willContinue = index < phases.lastIndex,
      isInitial = index == 0,
      isHold = start == end,
    )
  }
}
