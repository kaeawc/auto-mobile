package dev.jasonpearson.automobile.ctrlproxy.perf

import android.util.Log
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.ThreadContextElement
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.encodeToJsonElement

/** Request ownership copied to worker threads while a request coroutine is running. */
internal class PerfRequestContext(val requestId: String?) :
  AbstractCoroutineContextElement(PerfRequestContext), ThreadContextElement<String?> {

  override fun updateThreadContext(context: CoroutineContext): String? {
    val previous = currentRequestId.get()
    currentRequestId.set(requestId)
    return previous
  }

  override fun restoreThreadContext(context: CoroutineContext, oldState: String?) {
    currentRequestId.set(oldState)
  }

  companion object Key : CoroutineContext.Key<PerfRequestContext> {
    private val currentRequestId = ThreadLocal<String?>()

    fun currentRequestId(): String? = currentRequestId.get()
  }
}

/** Performance timing entry that matches the TypeScript implementation format. */
@Serializable
data class PerfTiming(
  val name: String,
  val durationMs: Long,
  val children: List<PerfTiming>? = null,
)

/** Internal mutable timing entry for building up timing data. */
internal data class MutablePerfEntry(
  val name: String,
  val startTime: Long,
  val requestId: String? = PerfRequestContext.currentRequestId(),
  var endTime: Long? = null,
  val children: MutableList<MutablePerfEntry> = mutableListOf(),
  val isParallel: Boolean = false,
) {
  fun toTiming(): PerfTiming {
    val duration = (endTime ?: System.currentTimeMillis()) - startTime
    val childTimings = if (children.isEmpty()) null else children.map { it.toTiming() }
    return PerfTiming(name = name, durationMs = duration, children = childTimings)
  }
}

/**
 * Singleton provider for accumulating performance timing data.
 *
 * Usage:
 * ```
 * val perf = PerfProvider.instance
 *
 * // Track an operation
 * perf.track("operationName") {
 *     // do work
 * }
 *
 * // Or manually track
 * perf.startOperation("operationName")
 * // do work
 * perf.endOperation("operationName")
 *
 * // When sending a WebSocket message, flush all timing data
 * val timings = perf.flush()
 * ```
 */
class PerfProvider private constructor(timeProvider: TimeProvider = SystemTimeProvider()) :
  PerfOperationTracker(timeProvider) {
  companion object {
    private const val TAG = "PerfProvider"
    private const val MAX_COMPLETED_ENTRIES = 1_000

    @Volatile private var INSTANCE: PerfProvider? = null

    val instance: PerfProvider
      get() = INSTANCE ?: synchronized(this) { INSTANCE ?: PerfProvider().also { INSTANCE = it } }

    /** For testing - allows injecting a custom TimeProvider. */
    fun createForTesting(timeProvider: TimeProvider): PerfProvider {
      return PerfProvider(timeProvider)
    }

    /** Reset the singleton instance (for testing). */
    fun resetInstance() {
      synchronized(this) { INSTANCE = null }
    }
  }

  private val json = Json { prettyPrint = false }

  // Completed roots are grouped by the request context active when they started.
  // Completion and drain snapshots share a lock so racing entries remain queued.
  private val completedEntriesLock = Any()
  private val completedEntries = LinkedHashMap<String?, MutableList<MutablePerfEntry>>()
  private var completedEntryCount = 0
  private var loggedCompletedEntryEviction = false

  internal override fun complete(entry: MutablePerfEntry) {
    synchronized(completedEntriesLock) {
      completedEntries.getOrPut(entry.requestId) { mutableListOf() }.add(entry)
      completedEntryCount++
      while (completedEntryCount > MAX_COMPLETED_ENTRIES) {
        val oldestRequestId = completedEntries.keys.first()
        val evictedEntries = completedEntries.remove(oldestRequestId).orEmpty().size
        completedEntryCount -= evictedEntries
        if (!loggedCompletedEntryEviction) {
          loggedCompletedEntryEviction = true
          Log.d(TAG, "Evicted completed performance timings after exceeding retained-entry limit")
        }
      }
    }
  }

  /** Drop completed timings after the owning request scope finishes. */
  internal fun discard(requestId: String?) {
    synchronized(completedEntriesLock) {
      completedEntryCount -= completedEntries.remove(requestId).orEmpty().size
    }
  }

  /** Run request-owned work and release any completed entries when that scope ends. */
  internal suspend fun <T> withRequestScope(requestId: String?, block: suspend () -> T): T =
    try {
      block()
    } finally {
      discard(requestId)
    }

  /** Track an operation with automatic start/end timing. Returns the result of the block. */
  inline fun <T> track(name: String, block: () -> T): T {
    startOperation(name)
    try {
      return block()
    } finally {
      endOperation(name)
    }
  }

  /**
   * Flush timing data for the current request context and reset it. Returns the timing data as a
   * JsonElement for inclusion in WebSocket messages.
   */
  fun flush(): JsonElement? = flush(PerfRequestContext.currentRequestId())

  /** Drain only timings owned by [requestId]. */
  internal fun flush(requestId: String?): JsonElement? = flush(requestId) {}

  /** [afterSnapshot] is an internal synchronization seam for deterministic concurrency tests. */
  internal fun flush(requestId: String?, afterSnapshot: () -> Unit): JsonElement? {
    // End any incomplete entries on this thread (moves their roots into the pool)
    val state = localState
    while (state.entryStack.isNotEmpty()) {
      end()
    }

    // Snapshot and remove this request's completed roots atomically. Completions
    // racing with conversion are retained for the next flush.
    val completed =
      synchronized(completedEntriesLock) {
        val removed = completedEntries.remove(requestId).orEmpty().toList()
        completedEntryCount -= removed.size
        removed
      }
    afterSnapshot()
    val entries = completed.mapTo(mutableListOf()) { it.toTiming() }

    return if (entries.isEmpty()) {
      null
    } else {
      json.encodeToJsonElement(entries)
    }
  }

  /** Get current timing data without clearing (for debugging). */
  fun peek(): List<PerfTiming> {
    val entries = mutableListOf<PerfTiming>()

    // Include this thread's current root if any
    localState.currentRoot?.let { entries.add(it.toTiming()) }

    // Include all completed entries for debugging, independent of request owner.
    synchronized(completedEntriesLock) {
      completedEntries.values.flatten().forEach { entries.add(it.toTiming()) }
    }

    return entries
  }

  /** Check if there's any accumulated timing data. */
  fun hasData(): Boolean {
    val hasCompleted = synchronized(completedEntriesLock) { completedEntries.isNotEmpty() }
    return hasCompleted || localState.currentRoot != null
  }

  /** Clear all timing data without returning it. */
  fun clear() {
    val state = localState
    state.entryStack.clear()
    state.currentRoot = null
    synchronized(completedEntriesLock) {
      completedEntries.clear()
      completedEntryCount = 0
    }
  }
}
