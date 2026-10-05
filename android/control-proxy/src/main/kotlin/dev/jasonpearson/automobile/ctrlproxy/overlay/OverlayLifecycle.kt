package dev.jasonpearson.automobile.ctrlproxy.overlay

const val DEFAULT_OVERLAY_IDLE_TTL_MILLIS = 300_000L

/** Delay before retrying an expiry whose window removal failed, and how many retries are made. */
const val OVERLAY_DISMISS_RETRY_MILLIS = 5_000L
const val OVERLAY_DISMISS_MAX_RETRIES = 3

/** A cancellable one-shot task. Unlike OverlaySettleTimer, it does not block a gesture caller. */
fun interface OverlayScheduledTask {
  fun cancel()
}

fun interface OverlayScheduler {
  fun schedule(millis: Long, action: suspend () -> Unit): OverlayScheduledTask
}

enum class OverlayDismissReason(val wireValue: String) {
  USER("user"),
  AGENT("agent"),
  DISCONNECT("disconnect"),
  TTL("ttl"),
  TEARDOWN("teardown"),
}

enum class OverlayWindowDecision {
  RELAYOUT,
  HIDE,
  DISMISS,
}

/** A removed display ends its window lifetime; never migrate authored content to another panel. */
fun overlayWindowDecision(displayAvailable: Boolean, blocked: Boolean): OverlayWindowDecision =
  when {
    !displayAvailable -> OverlayWindowDecision.DISMISS
    blocked -> OverlayWindowDecision.HIDE
    else -> OverlayWindowDecision.RELAYOUT
  }

/** Controller-serialized idle policy. Activity includes interactions and accepted updates only. */
class OverlayLifecycle(
  private val scheduler: OverlayScheduler,
  ttlMillis: Long = DEFAULT_OVERLAY_IDLE_TTL_MILLIS,
  val isBlocked: () -> Boolean = { false },
  val observerSession: () -> Int = { 0 },
  /** Connected observers right now; the default reports "unknown" as one so nothing is dropped. */
  val clientCount: () -> Int = { 1 },
) {
  var ttlMillis: Long = ttlMillis
    set(value) {
      require(value > 0) { "Overlay idle TTL must be positive" }
      field = value
    }

  private var generation = 0L
  private var task: OverlayScheduledTask? = null

  init {
    require(ttlMillis > 0) { "Overlay idle TTL must be positive" }
  }

  fun arm(delayMillis: Long = ttlMillis, onExpired: suspend (Long) -> Unit) {
    cancel()
    val token = generation
    task = scheduler.schedule(delayMillis) { onExpired(token) }
  }

  fun isCurrent(token: Long): Boolean = token == generation

  fun cancel() {
    generation++
    task?.cancel()
    task = null
  }
}
