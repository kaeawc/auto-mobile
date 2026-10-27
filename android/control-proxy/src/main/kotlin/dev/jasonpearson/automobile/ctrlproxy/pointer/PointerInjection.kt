package dev.jasonpearson.automobile.ctrlproxy.pointer

/**
 * Stylus and hover injection through `UiAutomation.injectInputEvent` (#13097), the route
 * accessibility `dispatchGesture` cannot offer: tool type, pressure, tilt, buttons and hover.
 *
 * Everything here is framework-free so the planning, validation and execution order are covered by
 * fast JVM tests; only [UiAutomationPointerSink] touches `MotionEvent`.
 */
internal enum class PointerTool(val wire: String) {
  STYLUS("stylus"),
  MOUSE("mouse");

  companion object {
    fun fromWire(value: String?): PointerTool? = entries.firstOrNull { it.wire == value }
  }
}

/** One authored position: where the pointer is, and how long the move to it takes. */
internal data class PointerWaypoint(
  val x: Float,
  val y: Float,
  /** Milliseconds spent moving here from the previous waypoint; ignored on the first. */
  val durationMs: Long = 0,
  /** 0..1; a stroke only. Absent keeps the previous value (1 at the start). */
  val pressure: Float? = null,
  /** Hover distance, 0 (touching) to 1 (far); a stylus hover only. */
  val distance: Float? = null,
  /** Radians from the surface normal (`AXIS_TILT`), 0..PI/2. */
  val tilt: Float? = null,
  /** Radians (`AXIS_ORIENTATION`), -PI..PI. */
  val orientation: Float? = null,
)

internal data class PointerInjectionRequest(
  val tool: PointerTool,
  /** Hover enter, move and exit with no contact; otherwise a down, move and up stroke. */
  val hover: Boolean,
  val points: List<PointerWaypoint>,
  /** `MotionEvent` button state bits held for the whole stroke (`BUTTON_STYLUS_PRIMARY` = 32). */
  val buttons: Int = 0,
  val displayId: Int = 0,
)

internal enum class PointerAction {
  HOVER_ENTER,
  HOVER_MOVE,
  HOVER_EXIT,
  DOWN,
  MOVE,
  UP,
  CANCEL,
}

/** One event at an offset from the start of the injection. */
internal data class PlannedPointerEvent(
  val atMs: Long,
  val action: PointerAction,
  val x: Float,
  val y: Float,
  val pressure: Float,
  val distance: Float,
  val tilt: Float,
  val orientation: Float,
  val buttons: Int,
)

internal object PointerInjectionPlanner {
  /** `BUTTON_STYLUS_PRIMARY` | `BUTTON_STYLUS_SECONDARY`. */
  const val STYLUS_BUTTONS = 32 or 64

  const val MAX_POINTS = 100
  const val MAX_SEGMENT_MS = 5000L
  const val MAX_TOTAL_MS = 20_000L

  /** Gap between interpolated move events, so an app sees a smooth path. */
  const val MOVE_INTERVAL_MS = 16L

  /** First reason [request] cannot be injected, or null. Checked before any event is sent. */
  fun validate(request: PointerInjectionRequest): String? {
    val points = request.points
    return when {
      points.isEmpty() || points.size > MAX_POINTS -> "points must hold 1 to $MAX_POINTS entries"
      else ->
        modeError(request)
          ?: points.indices.firstNotNullOfOrNull { index -> pointError(index, points[index]) }
          ?: totalDurationError(points)
    }
  }

  /** Reasons that depend on the tool, hover mode, buttons and display rather than on one point. */
  private fun modeError(request: PointerInjectionRequest): String? =
    when {
      request.tool == PointerTool.MOUSE && !request.hover ->
        "mouse input is supported for hover only"
      request.displayId != 0 ->
        "display ${request.displayId} is not supported; the instrumentation route injects on the default display"
      request.hover && request.buttons != 0 -> "hover has no contact, so no buttons are held"
      request.buttons and STYLUS_BUTTONS.inv() != 0 ->
        "buttons may hold only the stylus barrel buttons (32 and 64)"
      request.tool == PointerTool.MOUSE && request.points.any { it.distance != null } ->
        "a mouse has no hover distance"
      request.hover && request.points.any { it.pressure != null } -> "hover has no pressure"
      else -> null
    }

  private fun pointError(index: Int, point: PointerWaypoint): String? {
    val where = "points[$index]"
    val problem = positionError(point) ?: rangeError(point)
    return problem?.let { "$where: $it" }
  }

  private fun positionError(point: PointerWaypoint): String? =
    when {
      !point.x.isFinite() || !point.y.isFinite() || point.x < 0 || point.y < 0 ->
        "x and y must be finite and non-negative"
      point.durationMs !in 0..MAX_SEGMENT_MS -> "durationMs must be 0 to $MAX_SEGMENT_MS"
      else -> null
    }

  private fun rangeError(point: PointerWaypoint): String? {
    val pi = Math.PI.toFloat()
    return when {
      point.pressure != null && point.pressure !in 0f..1f -> "pressure must be 0 to 1"
      point.distance != null && point.distance !in 0f..1f -> "distance must be 0 to 1"
      point.tilt != null && point.tilt !in 0f..(pi / 2) -> "tilt must be 0 to PI/2 radians"
      point.orientation != null && point.orientation !in -pi..pi ->
        "orientation must be -PI to PI radians"
      else -> null
    }
  }

  private fun totalDurationError(points: List<PointerWaypoint>): String? {
    val total = points.drop(1).sumOf { it.durationMs }
    return if (total > MAX_TOTAL_MS) "total duration $total ms exceeds the $MAX_TOTAL_MS ms limit"
    else null
  }

  /** The timed event sequence for a valid [request]. */
  fun plan(request: PointerInjectionRequest): List<PlannedPointerEvent> {
    val points = request.points
    val state = AxisState.start(points.first(), request.hover, request.tool)
    val open = if (request.hover) PointerAction.HOVER_ENTER else PointerAction.DOWN
    val move = if (request.hover) PointerAction.HOVER_MOVE else PointerAction.MOVE
    val close = if (request.hover) PointerAction.HOVER_EXIT else PointerAction.UP
    val events = mutableListOf(state.event(0, open, points.first().x, points.first().y, request))
    var elapsed = 0L
    for (index in 1 until points.size) {
      val from = points[index - 1]
      val to = points[index]
      val frames = maxOf(1L, (to.durationMs + MOVE_INTERVAL_MS - 1) / MOVE_INTERVAL_MS)
      val begin = state.copy()
      for (frame in 1..frames) {
        val fraction = frame.toFloat() / frames
        state.blend(begin, to, fraction)
        val last = frame == frames
        val x = if (last) to.x else lerp(from.x, to.x, fraction)
        val y = if (last) to.y else lerp(from.y, to.y, fraction)
        events += state.event(elapsed + to.durationMs * frame / frames, move, x, y, request)
      }
      elapsed += to.durationMs
    }
    events += state.event(elapsed, close, points.last().x, points.last().y, request)
    return events
  }

  /** The interpolated axes at the current frame. */
  private data class AxisState(
    var pressure: Float,
    var distance: Float,
    var tilt: Float,
    var orientation: Float,
  ) {
    fun blend(begin: AxisState, to: PointerWaypoint, fraction: Float) {
      pressure = lerp(begin.pressure, to.pressure ?: begin.pressure, fraction)
      distance = lerp(begin.distance, to.distance ?: begin.distance, fraction)
      tilt = lerp(begin.tilt, to.tilt ?: begin.tilt, fraction)
      orientation = lerp(begin.orientation, to.orientation ?: begin.orientation, fraction)
    }

    fun event(
      at: Long,
      action: PointerAction,
      x: Float,
      y: Float,
      request: PointerInjectionRequest,
    ) =
      PlannedPointerEvent(at, action, x, y, pressure, distance, tilt, orientation, request.buttons)

    companion object {
      fun start(first: PointerWaypoint, hover: Boolean, tool: PointerTool) =
        AxisState(
          pressure = first.pressure ?: if (hover) 0f else 1f,
          distance = first.distance ?: if (hover && tool == PointerTool.STYLUS) 0.5f else 0f,
          tilt = first.tilt ?: 0f,
          orientation = first.orientation ?: 0f,
        )
    }
  }
}

private fun lerp(from: Float, to: Float, fraction: Float) = from + (to - from) * fraction
