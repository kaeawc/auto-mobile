package dev.jasonpearson.automobile.validation

import dev.jasonpearson.automobile.validation.CoordinationScheduleFeasibility.Deadlock
import dev.jasonpearson.automobile.validation.CoordinationScheduleFeasibility.Event
import dev.jasonpearson.automobile.validation.CoordinationScheduleFeasibility.StalledDevice
import dev.jasonpearson.automobile.validation.CoordinationScheduleFeasibility.Track

internal object CoordinationScheduleSearch {
  private class State(val positions: IntArray, val arrived: BooleanArray) {
    val key: String =
      positions.joinToString(",") + "|" + arrived.joinToString("") { if (it) "1" else "0" }
  }

  private class Successor(val state: State, val release: String?)

  private class Visit(val parent: String?, val release: String?)

  private class Candidate(val state: State, val progress: Int)

  private fun currentEvent(tracks: List<Track>, state: State, index: Int): Event? =
    tracks[index].events.getOrNull(state.positions[index])

  private fun isComplete(tracks: List<Track>, state: State): Boolean =
    tracks.indices.all { state.positions[it] >= tracks[it].events.size }

  private fun waitersAt(tracks: List<Track>, state: State, lock: String): List<Int> =
    tracks.indices.filter { state.arrived[it] && currentEvent(tracks, state, it)?.lock == lock }

  private fun arrive(tracks: List<Track>, state: State, index: Int): Successor {
    val event = checkNotNull(currentEvent(tracks, state, index))
    val positions = state.positions.copyOf()
    val arrived = state.arrived.copyOf()
    val generation = waitersAt(tracks, state, event.lock) + index

    if (generation.size < event.deviceCount) {
      arrived[index] = true
      return Successor(State(positions, arrived), null)
    }

    for (member in generation) {
      positions[member] += 1
      arrived[member] = false
    }
    val members = generation.map { tracks[it].device }.sorted().joinToString(", ")
    return Successor(State(positions, arrived), "\"${event.lock}\" {$members}")
  }

  private fun successorsOf(tracks: List<Track>, state: State): List<Successor> =
    tracks.indices
      .filter { !state.arrived[it] && currentEvent(tracks, state, it) != null }
      .map { arrive(tracks, state, it) }

  private fun releasedGenerationsTo(visited: Map<String, Visit>, key: String): List<String> {
    val releases = mutableListOf<String>()
    var cursor: String? = key
    while (cursor != null) {
      val visit = visited[cursor]
      visit?.release?.let { releases.add(it) }
      cursor = visit?.parent
    }
    return releases.reversed()
  }

  private fun describeStall(
    tracks: List<Track>,
    visited: Map<String, Visit>,
    candidate: Candidate,
  ): Deadlock {
    val state = candidate.state
    val stalled = mutableListOf<StalledDevice>()
    val finished = mutableListOf<String>()
    for (i in tracks.indices) {
      val event = currentEvent(tracks, state, i)
      if (event == null) {
        finished.add(tracks[i].device)
        continue
      }
      val waitingWith = waitersAt(tracks, state, event.lock).map { tracks[it].device }
      stalled.add(StalledDevice(tracks[i].device, event, waitingWith))
    }
    return Deadlock(stalled, finished, releasedGenerationsTo(visited, state.key))
  }

  fun searchComponent(tracks: List<Track>, maxStates: Int): Deadlock? {
    val initial = State(IntArray(tracks.size), BooleanArray(tracks.size))
    val visited = hashMapOf(initial.key to Visit(null, null))
    val stack = ArrayDeque<State>().apply { addLast(initial) }
    var deepest: Candidate? = null

    while (stack.isNotEmpty()) {
      val state = stack.removeLast()
      if (isComplete(tracks, state)) {
        return null
      }
      val successors = successorsOf(tracks, state)
      if (successors.isEmpty()) {
        val progress = state.positions.sum()
        if (deepest == null || progress > deepest.progress) {
          deepest = Candidate(state, progress)
        }
        continue
      }
      for (successor in successors) {
        val nextKey = successor.state.key
        if (visited.containsKey(nextKey)) {
          continue
        }
        if (visited.size >= maxStates) {
          // Search bound reached: feasibility unknown, so never reject.
          return null
        }
        visited[nextKey] = Visit(state.key, successor.release)
        stack.addLast(successor.state)
      }
    }

    return deepest?.let { describeStall(tracks, visited, it) }
  }
}
