package dev.jasonpearson.automobile.validation

/**
 * Static scheduling feasibility for multi-device barrier / criticalSection plans (issue #6231) -- a
 * port of the daemon's `src/utils/plan/CoordinationScheduleFeasibility.ts`. Keep the two in
 * lockstep: both are driven by the shared cases in
 * `test/fixtures/plan-schedule-feasibility/cases.json`, and they must reach the same verdicts and
 * produce the same messages (including the representative stall), so the search order below mirrors
 * the TypeScript one exactly.
 *
 * Execution model (mirrors the runtime, see PlanPartitioner and
 * CriticalSectionCoordinator.waitAtBarrier):
 * - Each device's steps form one track that runs strictly sequentially, so a device blocked at a
 *   coordination step cannot reach any later step.
 * - A coordination step (barrier, or the rendezvous at the start of a criticalSection) on lock L
 *   with deviceCount N is an "arrival". The coordinator collects arrivals per lock and releases all
 *   of them once N have arrived (one "generation"), then starts the next generation empty.
 * - Non-coordination steps take arbitrary time, so any device that is not blocked may be the next
 *   to arrive anywhere: every arrival order is a possible runtime timing.
 *
 * The check explores that state space exhaustively (state = each track's position plus whether the
 * device is already waiting at its current lock). A plan is rejected only when NO arrival order
 * lets every track finish. Plans that complete under some timings but can deadlock under others
 * (e.g. deviceCount=2 with arrivals A,B,A,C) are deliberately accepted (owner decision on #6231).
 *
 * Tracks are first split into independent components (devices linked by a shared lock); each
 * component is searched separately, so the state budget applies per component and an unmodeled
 * event opts out only its own component. When a component's search hits [MAX_SCHEDULE_STATES] its
 * result is "unknown" and it is accepted (never a false rejection).
 */
internal object CoordinationScheduleFeasibility {
  const val MAX_SCHEDULE_STATES = 10_000

  data class Event(
    val tool: String,
    val lock: String,
    val deviceCount: Long,
    val stepIndex: Int,
    /**
     * True when the runtime may not follow the model for this arrival (an `optional` step can time
     * out and continue; a criticalSection with nested coordination waits again under the section
     * mutex). The whole component containing it is skipped.
     */
    val unmodeled: Boolean = false,
  )

  data class Track(val device: String, val events: List<Event>)

  data class StalledDevice(
    val device: String,
    val event: Event,
    /** Devices (including this one) already waiting at the same lock. */
    val waitingWith: List<String>,
  )

  data class Deadlock(
    val stalled: List<StalledDevice>,
    /** Devices that finished every coordination step before the stall. */
    val finished: List<String>,
    /** Generations released before the stall, in order, e.g. `"X" {A, B}`. */
    val releasedGenerations: List<String>,
  )

  private fun findRoot(parents: Map<String, String>, node: String): String {
    var root = node
    while (parents[root] != root) {
      root = checkNotNull(parents[root])
    }
    return root
  }

  /**
   * Splits tracks into independent components: two tracks are in the same component when they
   * (transitively) share a lock. Components cannot block each other, so the plan completes iff
   * every component can complete.
   */
  fun splitIndependentComponents(tracks: List<Track>): List<List<Track>> {
    val parents = mutableMapOf<String, String>()
    fun nodeOf(kind: String, name: String): String {
      val node = "$kind:$name"
      parents.putIfAbsent(node, node)
      return node
    }
    for (track in tracks) {
      val deviceNode = nodeOf("device", track.device)
      for (event in track.events) {
        parents[findRoot(parents, nodeOf("lock", event.lock))] = findRoot(parents, deviceNode)
      }
    }
    val components = linkedMapOf<String, MutableList<Track>>()
    for (track in tracks) {
      components
        .getOrPut(findRoot(parents, "device:${track.device}")) { mutableListOf() }
        .add(track)
    }
    return components.values.toList()
  }

  /**
   * Returns a representative deadlock when, in some independent component, no arrival order lets
   * every track finish; null when every analyzed component can complete, is unmodeled, or exhausts
   * the search bound.
   */
  fun findUnavoidableDeadlock(
    tracks: List<Track>,
    maxStates: Int = MAX_SCHEDULE_STATES,
  ): Deadlock? {
    for (component in splitIndependentComponents(tracks)) {
      val unmodeled = component.any { track -> track.events.any { it.unmodeled } }
      val deadlock =
        if (unmodeled) null else CoordinationScheduleSearch.searchComponent(component, maxStates)
      if (deadlock != null) {
        return deadlock
      }
    }
    return null
  }

  private fun describeStalledDevice(stalled: StalledDevice): String {
    val event = stalled.event
    val arrivedCount = stalled.waitingWith.size
    return "device \"${stalled.device}\" waits at ${event.tool} lock \"${event.lock}\" " +
      "(step ${event.stepIndex}; $arrivedCount/${event.deviceCount} arrived: " +
      "${stalled.waitingWith.joinToString(", ")})"
  }

  /** Formats a deadlock as an actionable validation message, identical to the daemon's. */
  fun formatDeadlock(deadlock: Deadlock): String {
    val locks = deadlock.stalled.map { "\"${it.event.lock}\"" }.distinct()
    val released =
      if (deadlock.releasedGenerations.isNotEmpty()) {
        deadlock.releasedGenerations.joinToString(" -> ")
      } else {
        "none"
      }
    val finished =
      if (deadlock.finished.isNotEmpty()) {
        " Tracks already finished (cannot arrive again): ${deadlock.finished.joinToString(", ")}."
      } else {
        ""
      }
    return "barrier/criticalSection coordination can never complete: under every possible " +
      "arrival order at least one device track deadlocks. " +
      "One reachable stall: ${deadlock.stalled.joinToString("; ") { describeStalledDevice(it) }}. " +
      "Locks involved: ${locks.joinToString(", ")}. " +
      "Generations released before the stall: $released.$finished " +
      "Each device's track runs sequentially, so a device blocked at one lock never reaches the " +
      "later lock its peers are waiting at. " +
      "Reorder the coordination steps so devices visit shared locks in a consistent order, or " +
      "add the arrivals the stalled locks are missing."
  }
}
