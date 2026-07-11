package dev.jasonpearson.automobile.ctrlproxy.perf

import android.util.Log
import java.util.concurrent.ConcurrentLinkedDeque
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.encodeToJsonElement

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
class PerfProvider
private constructor(private val timeProvider: TimeProvider = SystemTimeProvider()) {
  companion object {
    private const val TAG = "PerfProvider"

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

  // Per-thread active-entry state. The entry stack and current root are kept
  // per-thread so an operation on one thread (e.g. hierarchy polling) never nests
  // under an in-flight operation on another (e.g. command handling), and end()/
  // flush()/independentRoot() can't close/steal another thread's open entries
  // (issue #3709, the twin of iOS #3635). Completed roots are still moved into the
  // shared completedEntries pool below, so flush() reports all threads' timings.
  private class LocalState {
    val entryStack = java.util.ArrayDeque<MutablePerfEntry>()
    var currentRoot: MutablePerfEntry? = null
  }

  private val threadState = ThreadLocal.withInitial { LocalState() }

  private fun local(): LocalState = threadState.get()

  // Root entries that have been completed. Shared across threads.
  private val completedEntries = ConcurrentLinkedDeque<MutablePerfEntry>()

  // Debounce tracking (shared)
  private var debounceCount = 0
  private var lastDebounceTime: Long? = null

  /** Start a serial block (operations run sequentially). */
  fun serial(name: String) {
    val state = local()
    val now = timeProvider.currentTimeMillis()
    val entry = MutablePerfEntry(name = name, startTime = now, isParallel = false)

    val parent = state.entryStack.peekLast()
    if (parent != null) {
      parent.children.add(entry)
    } else {
      state.currentRoot = entry
    }
    state.entryStack.addLast(entry)

    Log.d(TAG, "Started serial block: $name")
  }

  /**
   * Start a new independent root block, ending any currently open blocks first. Use this for
   * operations that may run concurrently and should be tracked as parallel/sibling entries rather
   * than nested within each other.
   *
   * Any open blocks are closed and moved to completedEntries, preserving their timing data for
   * inclusion in the next flush().
   */
  fun independentRoot(name: String) {
    // End all open entries on THIS thread - they become completed siblings
    val state = local()
    while (state.entryStack.isNotEmpty()) {
      end()
    }

    // Start fresh root
    serial(name)
  }

  /** Start a parallel block (operations run concurrently). */
  fun parallel(name: String) {
    val state = local()
    val now = timeProvider.currentTimeMillis()
    val entry = MutablePerfEntry(name = name, startTime = now, isParallel = true)

    val parent = state.entryStack.peekLast()
    if (parent != null) {
      parent.children.add(entry)
    } else {
      state.currentRoot = entry
    }
    state.entryStack.addLast(entry)

    Log.d(TAG, "Started parallel block: $name")
  }

  /** End the current block. */
  fun end() {
    val state = local()
    val now = timeProvider.currentTimeMillis()
    val entry = state.entryStack.pollLast()

    if (entry != null) {
      entry.endTime = now
      Log.d(TAG, "Ended block: ${entry.name} (${now - entry.startTime}ms)")

      // If this was the root entry, move it to the shared completed pool
      if (state.entryStack.isEmpty() && state.currentRoot == entry) {
        completedEntries.add(entry)
        state.currentRoot = null
      }
    } else {
      Log.w(TAG, "end() called with no active block")
    }
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

  /** Track a suspend operation with automatic start/end timing. Returns the result of the block. */
  suspend inline fun <T> trackSuspend(name: String, crossinline block: suspend () -> T): T {
    startOperation(name)
    try {
      return block()
    } finally {
      endOperation(name)
    }
  }

  /** Start tracking an operation manually. */
  fun startOperation(name: String) {
    val state = local()
    val now = timeProvider.currentTimeMillis()
    val entry = MutablePerfEntry(name = name, startTime = now)

    val parent = state.entryStack.peekLast()
    if (parent != null) {
      parent.children.add(entry)
      state.entryStack.addLast(entry)
    } else {
      // No active block, this becomes a root entry
      state.currentRoot = entry
      state.entryStack.addLast(entry)
    }

    Log.d(TAG, "Started operation: $name")
  }

  /** End tracking an operation manually. */
  fun endOperation(name: String) {
    val state = local()
    val now = timeProvider.currentTimeMillis()

    // Find the matching entry in this thread's stack
    val entry = state.entryStack.peekLast()
    if (entry != null && entry.name == name) {
      entry.endTime = now
      state.entryStack.pollLast()
      Log.d(TAG, "Ended operation: $name (${now - entry.startTime}ms)")

      // If this was the root entry, move it to the shared completed pool
      if (state.entryStack.isEmpty() && state.currentRoot == entry) {
        completedEntries.add(entry)
        state.currentRoot = null
      }
    } else {
      Log.w(TAG, "endOperation($name) called but current entry is ${entry?.name}")
    }
  }

  /** Record a debounce event (when hierarchy updates are debounced). */
  fun recordDebounce() {
    debounceCount++
    lastDebounceTime = timeProvider.currentTimeMillis()
    Log.d(TAG, "Debounce recorded (total: $debounceCount)")
  }

  /**
   * Flush all accumulated timing data and reset. Returns the timing data as a JsonElement for
   * inclusion in WebSocket messages.
   */
  fun flush(): JsonElement? {
    // End any incomplete entries on this thread (moves their roots into the pool)
    val state = local()
    while (state.entryStack.isNotEmpty()) {
      end()
    }

    // Collect all completed entries
    val entries = mutableListOf<PerfTiming>()
    while (completedEntries.isNotEmpty()) {
      val entry = completedEntries.pollFirst()
      if (entry != null) {
        entries.add(entry.toTiming())
      }
    }

    // Include debounce info if any
    val debounceInfo =
      if (debounceCount > 0) {
        val info =
          PerfTiming(
            name = "debounce",
            durationMs = 0,
            children =
              listOf(
                PerfTiming(name = "count", durationMs = debounceCount.toLong()),
                PerfTiming(name = "lastTime", durationMs = lastDebounceTime ?: 0),
              ),
          )
        debounceCount = 0
        lastDebounceTime = null
        info
      } else {
        null
      }

    if (debounceInfo != null) {
      entries.add(debounceInfo)
    }

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
    local().currentRoot?.let { entries.add(it.toTiming()) }

    // Include shared completed entries
    completedEntries.forEach { entries.add(it.toTiming()) }

    return entries
  }

  /** Check if there's any accumulated timing data. */
  fun hasData(): Boolean {
    return completedEntries.isNotEmpty() || local().currentRoot != null || debounceCount > 0
  }

  /** Clear all timing data without returning it. */
  fun clear() {
    val state = local()
    state.entryStack.clear()
    state.currentRoot = null
    completedEntries.clear()
    debounceCount = 0
    lastDebounceTime = null
  }
}
