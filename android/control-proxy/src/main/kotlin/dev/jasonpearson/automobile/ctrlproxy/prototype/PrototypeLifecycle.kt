package dev.jasonpearson.automobile.ctrlproxy.prototype

const val DEFAULT_PROTOTYPE_IDLE_TTL_MILLIS = 300_000L

/** Delay before retrying an expiry whose window removal failed, and how many retries are made. */
const val PROTOTYPE_DISMISS_RETRY_MILLIS = 5_000L
const val PROTOTYPE_DISMISS_MAX_RETRIES = 3

/** A cancellable one-shot task. Unlike PrototypeSettleTimer, it does not block a gesture caller. */
fun interface PrototypeScheduledTask {
  fun cancel()
}

fun interface PrototypeScheduler {
  fun schedule(millis: Long, action: suspend () -> Unit): PrototypeScheduledTask
}

enum class PrototypeDismissReason(val wireValue: String) {
  USER("user"),
  AGENT("agent"),
  DISCONNECT("disconnect"),
  TTL("ttl"),
  TEARDOWN("teardown"),
}

enum class PrototypeWindowDecision {
  RELAYOUT,
  HIDE,
  DISMISS,
}

/** A removed display ends its window lifetime; never migrate authored content to another panel. */
fun prototypeWindowDecision(displayAvailable: Boolean, blocked: Boolean): PrototypeWindowDecision =
  when {
    !displayAvailable -> PrototypeWindowDecision.DISMISS
    blocked -> PrototypeWindowDecision.HIDE
    else -> PrototypeWindowDecision.RELAYOUT
  }

/** Controller-serialized idle policy. Activity includes interactions and accepted updates only. */
class PrototypeLifecycle(
  private val scheduler: PrototypeScheduler,
  ttlMillis: Long = DEFAULT_PROTOTYPE_IDLE_TTL_MILLIS,
  val isBlocked: () -> Boolean = { false },
  val observerSession: () -> Int = { 0 },
  /** Connected observers right now; the default reports "unknown" as one so nothing is dropped. */
  val clientCount: () -> Int = { 1 },
) {
  var ttlMillis: Long = ttlMillis
    set(value) {
      require(value > 0) { "Prototype idle TTL must be positive" }
      field = value
    }

  private var generation = 0L
  private var task: PrototypeScheduledTask? = null

  init {
    require(ttlMillis > 0) { "Prototype idle TTL must be positive" }
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
