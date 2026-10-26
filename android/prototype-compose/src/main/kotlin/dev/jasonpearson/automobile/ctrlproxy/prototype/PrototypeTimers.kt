package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import dev.jasonpearson.automobile.protocol.PrototypeAction
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.protocol.PrototypeStartTimerAction
import dev.jasonpearson.automobile.protocol.PrototypeTimerReport
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class PrototypeTimerAdvanceLimitException(val fired: Int) :
  IllegalStateException("Prototype timer advance exceeded 10000 fires")

/** Owned by one runtime; all calls, including scheduled fires, share its interaction lock. */
@OptIn(InternalAutoMobilePrototypeApi::class)
internal class PrototypeTimers(
  private val clock: () -> Long,
  private val scope: CoroutineScope,
  private val exclusively: suspend (suspend () -> Unit) -> Unit,
  private val warn: (Exception) -> Unit = {
    Log.w("PrototypeTimers", "Prototype timer fire failed", it)
  },
  private val fire: suspend (List<PrototypeAction>) -> Unit,
) {
  private class Timer(val action: PrototypeStartTimerAction, var at: Long, val order: Long) {
    var runs = 0
  }

  private val ledger = linkedMapOf<String, Timer>()
  private var order = 0L
  private var offset = 0L
  private var cursor: Long? = null
  private var pausedAt: Long? = null
  private var job: Job? = null
  private var processing = false
  private var closed = false

  private val now: Long
    get() = cursor ?: pausedAt ?: (clock() + offset)

  private val first: Timer?
    get() = ledger.values.minWithOrNull(compareBy({ it.at }, { it.order }))

  fun start(action: PrototypeStartTimerAction) {
    if (
      closed || (action.id !in ledger && ledger.size >= PrototypeSpecValidator.MAX_PROTOTYPE_TIMERS)
    )
      return
    ledger[action.id] = Timer(action, now + action.afterMs, ++order)
    schedule()
  }

  fun cancel(id: String) {
    ledger.remove(id)
    schedule()
  }

  fun cancelAll() {
    closed = true
    ledger.clear()
    job?.cancel()
    job = null
  }

  fun pause() {
    if (pausedAt != null || closed) return
    pausedAt = now
    job?.cancel()
    job = null
  }

  fun resume() {
    val paused = pausedAt ?: return
    val elapsed = clock() + offset - paused
    ledger.values.forEach { it.at += elapsed }
    pausedAt = null
    schedule()
  }

  fun reports(): List<PrototypeTimerReport> =
    ledger.values.sortedWith(compareBy({ it.at }, { it.order })).map {
      PrototypeTimerReport(it.action.id, (it.at - now).coerceAtLeast(0), it.runs)
    }

  suspend fun advance(ms: Int): Int {
    require(ms in 1..PrototypeSpecValidator.MAX_PROTOTYPE_TIMER_MS) {
      "advanceTimeMs must be between 1 and 3600000"
    }
    if (closed || pausedAt != null) return 0
    job?.cancel()
    job = null
    return drain(now + ms, shiftClock = true)
  }

  private suspend fun drain(target: Long, shiftClock: Boolean = false): Int {
    processing = true
    var fired = 0
    var reached = target
    try {
      while (!closed && pausedAt == null) {
        val timer = first?.takeIf { it.at <= target } ?: break
        if (fired == PrototypeSpecValidator.MAX_PROTOTYPE_TIMER_RUNS) {
          reached = checkNotNull(cursor)
          throw PrototypeTimerAdvanceLimitException(fired)
        }
        cursor = timer.at
        // Keep the identity registered during the fire: self-cancel and replacement win.
        fireOnce(timer)
        fired++
        timer.runs++
        if (ledger[timer.action.id] !== timer) continue
        val period = timer.action.everyMs
        val maxRuns = timer.action.maxRuns
        if (period != null && (maxRuns == null || timer.runs < maxRuns)) {
          timer.at += period
        } else ledger.remove(timer.action.id)
      }
      return fired
    } finally {
      if (shiftClock) offset = reached - clock()
      cursor = null
      processing = false
      schedule()
    }
  }

  /**
   * A failing fire is reported and counted; cancellation and non-Exception throwables propagate.
   */
  private suspend fun fireOnce(timer: Timer) {
    when (val failure = runCatching { fire(timer.action.actions) }.exceptionOrNull()) {
      null -> Unit
      is CancellationException -> throw failure
      is Exception -> warn(failure)
      else -> throw failure
    }
  }

  private fun schedule() {
    if (processing) return
    job?.cancel()
    job = null
    if (closed || pausedAt != null) return
    val next = first ?: return
    job =
      scope
        .launch(start = CoroutineStart.LAZY) {
          delay((next.at - now).coerceAtLeast(0))
          exclusively {
            job = null
            if (!closed && pausedAt == null) drain(now)
          }
        }
        .also { it.start() }
  }
}
