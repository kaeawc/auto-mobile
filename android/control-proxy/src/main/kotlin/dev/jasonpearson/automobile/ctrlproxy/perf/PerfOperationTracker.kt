package dev.jasonpearson.automobile.ctrlproxy.perf

import android.util.Log

/** Per-thread serial and parallel operation stack used by [PerfProvider]. */
abstract class PerfOperationTracker internal constructor(private val timeProvider: TimeProvider) {
  private companion object {
    const val TAG = "PerfProvider"
  }

  // Per-thread active-entry state. The entry stack and current root are kept
  // per-thread so an operation on one thread (e.g. hierarchy polling) never nests
  // under an in-flight operation on another (e.g. command handling), and end()/
  // flush()/independentRoot() can't close/steal another thread's open entries
  // (issue #3709, the twin of iOS #3635). Completed roots are grouped by request
  // context in PerfProvider, so each response flush reports its own request's timings.
  internal class LocalState {
    val entryStack = java.util.ArrayDeque<MutablePerfEntry>()
    var currentRoot: MutablePerfEntry? = null
  }

  private val threadState = ThreadLocal.withInitial { LocalState() }

  internal val localState: LocalState
    get() = threadState.get()

  internal abstract fun complete(entry: MutablePerfEntry)

  /** Start a serial block (operations run sequentially). */
  fun serial(name: String) {
    val state = localState
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
    val state = localState
    while (state.entryStack.isNotEmpty()) {
      end()
    }

    // Start fresh root
    serial(name)
  }

  /** Start a parallel block (operations run concurrently). */
  fun parallel(name: String) {
    val state = localState
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
    val state = localState
    val now = timeProvider.currentTimeMillis()
    val entry = state.entryStack.pollLast()

    if (entry != null) {
      entry.endTime = now
      Log.d(TAG, "Ended block: ${entry.name} (${now - entry.startTime}ms)")

      // If this was the root entry, move it to the completed queue for its request.
      if (state.entryStack.isEmpty() && state.currentRoot == entry) {
        complete(entry)
        state.currentRoot = null
      }
    } else {
      Log.w(TAG, "end() called with no active block")
    }
  }

  /** Start tracking an operation manually. */
  fun startOperation(name: String) {
    val state = localState
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
    val state = localState
    val now = timeProvider.currentTimeMillis()

    // Find the matching entry in this thread's stack
    val entry = state.entryStack.peekLast()
    if (entry != null && entry.name == name) {
      entry.endTime = now
      state.entryStack.pollLast()
      Log.d(TAG, "Ended operation: $name (${now - entry.startTime}ms)")

      // If this was the root entry, move it to the completed queue for its request.
      if (state.entryStack.isEmpty() && state.currentRoot == entry) {
        complete(entry)
        state.currentRoot = null
      }
    } else {
      Log.w(TAG, "endOperation($name) called but current entry is ${entry?.name}")
    }
  }
}
