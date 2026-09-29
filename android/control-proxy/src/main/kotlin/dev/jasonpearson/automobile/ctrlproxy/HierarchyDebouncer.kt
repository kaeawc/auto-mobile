package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.SystemTimeProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.job
import kotlinx.coroutines.launch

object HierarchyQuiescence {
  const val POLL_MS = 50L
  const val TIMEOUT_MS = 500L
}

/** Result of hierarchy extraction with hash comparison. */
sealed class HierarchyResult {
  /** New hierarchy extracted with different structural content. */
  data class Changed(val hierarchy: ViewHierarchy, val hash: Int, val extractionTimeMs: Long) :
    HierarchyResult()

  /**
   * Hierarchy extracted but structure unchanged (animation only). Bounds may have changed but
   * text/content is the same.
   */
  data class Unchanged(
    val hierarchy: ViewHierarchy,
    val hash: Int,
    val extractionTimeMs: Long,
    val skippedEventCount: Int,
  ) : HierarchyResult()

  /** Failed to extract hierarchy. */
  data class Error(val message: String) : HierarchyResult()
}

/**
 * Smart debouncer for view hierarchy extraction.
 *
 * Uses structural hash comparison to detect when content actually changes vs. when only bounds are
 * changing during animations.
 *
 * Key optimization: During scroll/fling animations, many TYPE_WINDOW_CONTENT_CHANGED events fire
 * but only bounds change. By comparing structural hashes, we can:
 * - Detect animation mode: Same hash = skip waiting, broadcast immediately
 * - Detect real changes: Different hash = content changed, proceed normally
 *
 * This reduces observation latency from 600ms+ to ~50ms during animations.
 *
 * @param scope Coroutine scope for debounce jobs
 * @param timeProvider Time provider for testability
 * @param perfProvider Performance tracking provider
 * @param quickDebounceMs Short debounce to batch rapid events (default 5ms)
 * @param animationSkipWindowMs How long to skip extractions after detecting animation (default
 *   100ms)
 * @param extractHierarchy Function to extract the current hierarchy
 */
class HierarchyDebouncer
internal constructor(
  private val scope: CoroutineScope,
  private val timeProvider: TimeProvider = SystemTimeProvider(),
  private val perfProvider: PerfProvider = PerfProvider.instance,
  private val quickDebounceMs: Long = 5L,
  private val animationSkipWindowMs: Long = 100L,
  private var unsolicitedIntervalMs: Long = 250L,
  internal val stats: CtrlProxyWorkStats = CtrlProxyWorkStats(),
  private val beforeDebounceLock: () -> Unit = {},
  private val beforeDebounceCompletion: () -> Unit = {},
  private val extractHierarchy:
    (disableAllFiltering: Boolean, snapshotOptions: HierarchySnapshotOptions) -> ViewHierarchy?,
) {
  companion object {
    private const val TAG = "HierarchyDebouncer"
  }

  /*
   * Threading (#6447): this class is driven from the AccessibilityService main thread
   * (onAccessibilityEvent), the injected IO scope (debounced and immediate extractions) and caller
   * threads (extractNowBlocking/extractAfterQuiescence/reset). Every field below is guarded by
   * [eventLock], a short lock that is never held across extractHierarchy. [extractionLock] serializes
   * whole extractions; when both are needed the order is always extractionLock -> eventLock.
   */
  private val eventLock = Any()
  private val extractionLock = Any()

  // Last known structural hash
  private var lastStructuralHash: Int = 0

  // Animation mode tracking
  private var inAnimationMode: Boolean = false
  private var animationModeEndTime: Long = 0
  private var skippedEventCount: Int = 0

  // Debounce job
  private var debounceJob: Job? = null
  private var extractionInFlight = false
  private var pendingRefresh = false
  private var lastUnsolicitedStart: Long? = null

  // Extractions launched by extractNow, tracked so getState/reset can see and cancel them.
  private val immediateJobs = mutableSetOf<Job>()

  fun setUnsolicitedIntervalMs(intervalMs: Long) {
    synchronized(eventLock) {
      unsolicitedIntervalMs = intervalMs.coerceAtLeast(0L)
      if (pendingRefresh && !extractionInFlight) {
        debounceJob?.cancel()
        debounceJob = null
        schedulePendingRefresh()
      }
    }
  }

  private fun schedulePendingRefresh() {
    if (debounceJob?.isActive == true || extractionInFlight || !pendingRefresh) return
    val elapsed = lastUnsolicitedStart?.let { timeProvider.currentTimeMillis() - it }
    val waitMs =
      maxOf(
        quickDebounceMs,
        unsolicitedIntervalMs - (elapsed ?: unsolicitedIntervalMs),
        if (inAnimationMode) animationModeEndTime - timeProvider.currentTimeMillis() else 0L,
      )
    debounceJob =
      scope.launch(start = CoroutineStart.LAZY) {
        val self = coroutineContext.job
        try {
          delay(waitMs)
          beforeDebounceLock()
          synchronized(eventLock) {
            self.ensureActive()
            pendingRefresh = false
            extractionInFlight = true
            lastUnsolicitedStart = timeProvider.currentTimeMillis()
          }
          extractAndCompare()
          beforeDebounceCompletion()
        } finally {
          synchronized(eventLock) {
            if (debounceJob === self) {
              extractionInFlight = false
              debounceJob = null
              schedulePendingRefresh()
            }
          }
        }
      }
    debounceJob?.start()
  }

  // Flag to temporarily suppress flow emissions (during setText operations)
  @Volatile private var suppressFlowEmissions: Boolean = false

  // Timestamp of last accessibility event (for quiescence detection)
  @Volatile private var lastEventTimestamp: Long = 0

  // Flow for emitting hierarchy results
  private val _hierarchyFlow =
    MutableSharedFlow<HierarchyResult>(replay = 1, extraBufferCapacity = 10)
  val hierarchyFlow: SharedFlow<HierarchyResult> = _hierarchyFlow

  // Last emitted hierarchy (for quick access)
  @Volatile private var lastHierarchy: ViewHierarchy? = null

  /**
   * Called when an accessibility event is received that might change the hierarchy. Handles
   * debouncing and decides whether to extract based on animation detection.
   */
  fun onAccessibilityEvent() {
    stats.accessibilityEvents.incrementAndGet()
    val now = timeProvider.currentTimeMillis()
    lastEventTimestamp = now

    // Skip all extractions if flow emissions are suppressed (setText/imeAction in progress)
    // The operation will call extractAfterQuiescence which does its own final extraction
    if (suppressFlowEmissions) {
      Log.d(TAG, "Skipping extraction (operation in progress, flow suppressed)")
      return
    }

    synchronized(eventLock) {
      // Retain animation skipping, but remember the last event for a trailing refresh.
      if (inAnimationMode && now < animationModeEndTime) {
        skippedEventCount++
        stats.coalescedEvents.incrementAndGet()
        pendingRefresh = true
        schedulePendingRefresh()
        return
      }

      // Exit animation mode if window expired
      if (inAnimationMode) {
        Log.d(TAG, "Exiting animation mode after skipping $skippedEventCount events")
        inAnimationMode = false
      }

      if (
        pendingRefresh ||
          extractionInFlight ||
          lastUnsolicitedStart?.let { now - it < unsolicitedIntervalMs } == true
      ) {
        stats.coalescedEvents.incrementAndGet()
      }
      pendingRefresh = true
      schedulePendingRefresh()
    }
  }

  /**
   * Perform an immediate extraction (bypasses debounce and animation mode). This is async - returns
   * immediately after launching the extraction.
   */
  fun extractNow(disableAllFiltering: Boolean = false) {
    val job =
      scope.launch(start = CoroutineStart.LAZY) {
        extractAndCompare(disableAllFiltering = disableAllFiltering)
      }
    synchronized(eventLock) {
      inAnimationMode = false
      immediateJobs.add(job)
    }
    // Also fires for a job cancelled before it ever ran (reset or scope cancellation).
    job.invokeOnCompletion { synchronized(eventLock) { immediateJobs.remove(job) } }
    // Start outside eventLock: an undispatched start would take extractionLock under it.
    job.start()
  }

  /**
   * Perform an immediate extraction and wait for it to complete (blocking). This ensures the
   * hierarchy is extracted and pushed before returning. Use this when you need to guarantee the
   * hierarchy is fresh before sending a result.
   *
   * @param skipFlowEmit If true, skips emitting to the flow. Use this when the caller will
   *   broadcast the hierarchy directly to avoid race conditions with flow-based async broadcasts.
   * @param disableAllFiltering If true, disables filtering/optimization for this extraction.
   * @return The extracted hierarchy, or null if extraction failed.
   */
  fun extractNowBlocking(
    skipFlowEmit: Boolean = false,
    disableAllFiltering: Boolean = false,
    snapshotOptions: HierarchySnapshotOptions = HierarchySnapshotOptions(),
  ): ViewHierarchy? {
    synchronized(eventLock) {
      inAnimationMode = false
      if (!extractionInFlight) {
        debounceJob?.cancel()
        debounceJob = null
        pendingRefresh = false
      }
    }
    return kotlinx.coroutines.runBlocking {
      extractAndCompare(
        skipFlowEmit = skipFlowEmit,
        disableAllFiltering = disableAllFiltering,
        snapshotOptions = snapshotOptions,
      )
    }
  }

  /**
   * Wait for accessibility events to stop firing (quiescence), then extract hierarchy. This is the
   * preferred method for operations that modify UI state (like setText).
   *
   * Instead of using a fixed delay, this method dynamically waits until no accessibility events
   * have been received for [quiescenceMs], then extracts the hierarchy.
   *
   * Flow emissions are suppressed during this operation to prevent race conditions where debounced
   * extractions could broadcast stale hierarchies.
   *
   * @param quiescenceMs How long to wait with no events before considering UI settled (default
   *   50ms)
   * @param maxWaitMs Maximum time to wait for quiescence (default 500ms)
   * @param pollIntervalMs How often to check for quiescence (default 10ms)
   * @return The extracted hierarchy, or null if extraction failed.
   */
  fun extractAfterQuiescence(
    quiescenceMs: Long = HierarchyQuiescence.POLL_MS,
    maxWaitMs: Long = HierarchyQuiescence.TIMEOUT_MS,
    pollIntervalMs: Long = 10L,
    initialEventWaitMs: Long = 200L, // Max time to wait for first event
  ): ViewHierarchy? {
    val startTime = timeProvider.currentTimeMillis()
    val initialTimestamp = lastEventTimestamp // Capture timestamp BEFORE the action

    // Suppress flow emissions to prevent racing broadcasts from debounced extractions
    suppressFlowEmissions = true
    Log.d(
      TAG,
      "extractAfterQuiescence: suppressing flow emissions, waiting for first event then quiescence (${quiescenceMs}ms quiet)",
    )

    try {
      // Cancel only a queued job. An active extraction retains ownership through its finally.
      synchronized(eventLock) {
        if (!extractionInFlight) {
          debounceJob?.cancel()
          debounceJob = null
        }
        pendingRefresh = false
        inAnimationMode = false
      }

      val hierarchy =
        kotlinx.coroutines.runBlocking {
          // PHASE 1: Wait for at least one new accessibility event to fire
          // This is critical because ACTION_SET_TEXT completes before the accessibility
          // tree is updated. The tree update triggers TYPE_WINDOW_CONTENT_CHANGED events.
          var sawFirstEvent = false
          while (!sawFirstEvent) {
            val now = timeProvider.currentTimeMillis()
            val elapsed = now - startTime

            // Check if we've exceeded initial event wait time
            if (elapsed >= initialEventWaitMs) {
              Log.d(TAG, "extractAfterQuiescence: no events after ${elapsed}ms, proceeding anyway")
              break
            }

            // Check if a new event has fired since we started
            if (lastEventTimestamp != initialTimestamp) {
              Log.d(TAG, "extractAfterQuiescence: first event detected after ${elapsed}ms")
              sawFirstEvent = true
              break
            }

            delay(pollIntervalMs)
          }

          // PHASE 2: Wait for quiescence (no events for quiescenceMs)
          var lastCheckedTimestamp = lastEventTimestamp

          while (true) {
            val now = timeProvider.currentTimeMillis()
            val elapsed = now - startTime
            val timeSinceLastEvent = now - lastEventTimestamp

            // Check if we've exceeded max wait time
            if (elapsed >= maxWaitMs) {
              Log.w(
                TAG,
                "extractAfterQuiescence: max wait time exceeded (${elapsed}ms); hierarchy may be stale",
              )
              break
            }

            // Check if we've achieved quiescence
            if (timeSinceLastEvent >= quiescenceMs) {
              Log.d(
                TAG,
                "extractAfterQuiescence: quiescence achieved after ${elapsed}ms (no events for ${timeSinceLastEvent}ms)",
              )
              break
            }

            // Log if new event was detected
            if (lastEventTimestamp != lastCheckedTimestamp) {
              Log.d(TAG, "extractAfterQuiescence: new event detected, resetting quiescence timer")
              lastCheckedTimestamp = lastEventTimestamp
            }

            // Wait before checking again
            delay(pollIntervalMs)
          }

          // Now extract the hierarchy
          extractAndCompare(skipFlowEmit = true)
        }

      val totalWait = timeProvider.currentTimeMillis() - startTime
      Log.d(TAG, "extractAfterQuiescence: completed in ${totalWait}ms")

      return hierarchy
    } finally {
      // Always unsuppress flow emissions
      suppressFlowEmissions = false
      Log.d(TAG, "extractAfterQuiescence: flow emissions re-enabled")
    }
  }

  /**
   * Extract hierarchy and compare structural hash.
   *
   * IMPORTANT: The perf block MUST be closed BEFORE calling _hierarchyFlow.emit() because emit()
   * can suspend waiting for collectors. If a new accessibility event triggers another
   * extractAndCompare() while we're suspended on emit, its perf block would become a child of this
   * still-open block, causing nested accumulation.
   *
   * @param skipFlowEmit If true, skips emitting to the flow. Use this when the caller will
   *   broadcast directly to avoid race conditions.
   */
  private suspend fun extractAndCompare(
    skipFlowEmit: Boolean = false,
    disableAllFiltering: Boolean = false,
    snapshotOptions: HierarchySnapshotOptions = HierarchySnapshotOptions(),
  ): ViewHierarchy? {
    val startTime = timeProvider.currentTimeMillis()

    // Variables to hold results for emission after perf block closes
    var resultToEmit: HierarchyResult? = null
    var hierarchyToCache: ViewHierarchy? = null

    // The tree walk and shared comparison/cache state must advance as one extraction.
    synchronized(extractionLock) {
      perfProvider.independentRoot("hierarchyDebouncer")
      try {
        perfProvider.startOperation("extractHierarchy")
        stats.extractions.incrementAndGet()
        val hierarchy = extractHierarchy(disableAllFiltering, snapshotOptions)
        perfProvider.endOperation("extractHierarchy")

        if (hierarchy == null) {
          // Set the Error and fall through to the emit below. A `return` here would
          // unwind through `finally` and exit the function, skipping the emit block
          // so consumers never saw the Error (#3608).
          resultToEmit = HierarchyResult.Error("Failed to extract hierarchy")
        } else {
          val extractionTime = timeProvider.currentTimeMillis() - startTime

          perfProvider.startOperation("computeHash")
          val structuralHash = StructuralHasher.computeHash(hierarchy)
          perfProvider.endOperation("computeHash")

          // Compare-and-publish under eventLock so the hash, animation window and cached
          // hierarchy always describe the same extraction and are visible to the main thread.
          synchronized(eventLock) {
            if (structuralHash == lastStructuralHash) {
              stats.unchangedCaptures.incrementAndGet()
              // Structure unchanged - likely animation
              // Enter animation mode to skip subsequent events
              inAnimationMode = true
              animationModeEndTime = timeProvider.currentTimeMillis() + animationSkipWindowMs

              resultToEmit =
                HierarchyResult.Unchanged(
                  hierarchy = hierarchy,
                  hash = structuralHash,
                  extractionTimeMs = extractionTime,
                  skippedEventCount = skippedEventCount,
                )

              Log.d(
                TAG,
                "Structure unchanged (hash=$structuralHash), entering animation mode for ${animationSkipWindowMs}ms",
              )
            } else {
              // Structure changed - this is a real content change
              val oldHash = lastStructuralHash
              inAnimationMode = false
              lastStructuralHash = structuralHash

              resultToEmit =
                HierarchyResult.Changed(
                  hierarchy = hierarchy,
                  hash = structuralHash,
                  extractionTimeMs = extractionTime,
                )

              Log.d(TAG, "Structure changed (oldHash=$oldHash, newHash=$structuralHash)")
            }
            skippedEventCount = 0
            hierarchyToCache = hierarchy
            lastHierarchy = hierarchy
          }
        }
      } finally {
        // End perf block BEFORE emit to prevent nesting if emit suspends
        perfProvider.end()
      }
    }

    // Emit AFTER perf block is closed - this can suspend without causing nesting issues
    // Only emit to flow if not skipped AND emissions are not suppressed
    // suppressFlowEmissions is used during setText operations to prevent racing broadcasts
    if (!skipFlowEmit && !suppressFlowEmissions) {
      resultToEmit?.let { _hierarchyFlow.emit(it) }
    } else if (suppressFlowEmissions) {
      Log.d(TAG, "Flow emission suppressed (setText operation in progress)")
    }
    return hierarchyToCache
  }

  /** Get the last extracted hierarchy without triggering a new extraction. */
  fun getLastHierarchy(): ViewHierarchy? = lastHierarchy

  /**
   * Get the timestamp of the last accessibility event. Used by the TypeScript MCP server to check
   * if events have occurred since a request was made.
   */
  fun getLastEventTimestamp(): Long = lastEventTimestamp

  /**
   * Check if any accessibility events have occurred since the given timestamp. If no events have
   * occurred (stale), trigger an immediate extraction. This is used when the MCP server is waiting
   * for pushed data but no events are firing.
   *
   * @param sinceTimestamp The timestamp to compare against (usually the MCP request start time)
   */
  fun extractIfStale(sinceTimestamp: Long) {
    if (lastEventTimestamp <= sinceTimestamp) {
      // No events since the given timestamp - the UI is "stale" from MCP's perspective
      // Trigger immediate extraction to push current state
      Log.d(
        TAG,
        "extractIfStale: no events since $sinceTimestamp (lastEvent=$lastEventTimestamp), triggering extraction",
      )
      extractNow()
    } else {
      Log.d(
        TAG,
        "extractIfStale: events occurred since $sinceTimestamp (lastEvent=$lastEventTimestamp), skipping extraction",
      )
    }
  }

  /** Get current state for debugging. */
  fun getState(): DebounceState =
    synchronized(eventLock) {
      DebounceState(
        lastHash = lastStructuralHash,
        inAnimationMode = inAnimationMode,
        animationModeEndTime = animationModeEndTime,
        skippedEventCount = skippedEventCount,
        hasActiveJob = debounceJob?.isActive == true || immediateJobs.any { it.isActive },
      )
    }

  /** Reset all state (for testing or reconnection). */
  fun reset() {
    synchronized(eventLock) {
      debounceJob?.cancel()
      debounceJob = null
      pendingRefresh = false
      // Copy first: cancelling can run a completion handler that mutates the set inline.
      val immediate = immediateJobs.toList()
      immediateJobs.clear()
      immediate.forEach { it.cancel() }
      extractionInFlight = false
      lastUnsolicitedStart = null
      lastStructuralHash = 0
      inAnimationMode = false
      animationModeEndTime = 0
      skippedEventCount = 0
      lastHierarchy = null
    }
  }

  /** Debugging state info. */
  data class DebounceState(
    val lastHash: Int,
    val inAnimationMode: Boolean,
    val animationModeEndTime: Long,
    val skippedEventCount: Int,
    val hasActiveJob: Boolean,
  )
}
