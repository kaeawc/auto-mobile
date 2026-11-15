package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.strings

/**
 * The deterministic fake media engine (#14257), the twin of TypeScript's and Swift's
 * `PrototypeFakeMediaEngine`. All three replay `test/fixtures/prototype-media-sim`.
 *
 * Nothing decodes. Time is virtual: it moves only when the runtime's injected clock calls
 * [advance], so a playing player's position, end of media and looping are exact. [simulate] applies
 * a `media.*` event from `prototype simulate`. Events are reported only on status or `playing`
 * transitions, never on position ticks, and `buffering` stalls the playhead without one.
 */
class PrototypeFakeMediaEngine {
  /** One player's `/platform/media/players/<id>` state; [error] is set only in `error`. */
  data class State(
    val playing: Boolean,
    val positionMs: Long,
    val durationMs: Long,
    val buffering: Boolean,
    val status: String,
    val error: String? = null,
  )

  data class Event(val name: String, val payload: Map<String, Any>)

  data class SimRequest(
    val event: String,
    val player: String,
    /** `media.statusChanged` only. */
    val status: String? = null,
    /** Required when the event drives the player into `error`. */
    val code: String? = null,
    /** Advance the virtual clock by this much before applying the event. */
    val advanceMs: Long? = null,
  )

  /** `null` on success, else `unknown_player` or `invalid_args`. */
  enum class Failure(val code: String) {
    UNKNOWN_PLAYER("unknown_player"),
    INVALID_ARGS("invalid_args"),
  }

  private class Player(var state: State, val loop: Boolean)

  private val players = LinkedHashMap<String, Player>()
  private val emitted = mutableListOf<Event>()

  /** Every event reported so far, oldest first. */
  val events: List<Event>
    get() = emitted.toList()

  /** `/platform/media/players`: every loaded player's state, in load order. */
  fun snapshot(): Map<String, State> = players.mapValues { it.value.state }

  /** Load a player paused at 0; [durationMs] is `-1` when the source has no known end. */
  fun load(player: String, durationMs: Long, loop: Boolean = false) {
    val state = State(false, 0, durationMs, false, READY)
    players[player] = Player(state, loop)
    statusChanged(player, state)
  }

  fun play(player: String): Failure? =
    update(player) {
      when (it.status) {
        ERROR -> it
        ENDED -> it.copy(positionMs = 0, status = READY, playing = true)
        else -> it.copy(playing = true)
      }
    }

  fun pause(player: String): Failure? = update(player) { it.copy(playing = false) }

  fun seek(player: String, positionMs: Long): Failure? =
    update(player) {
      if (it.status == ERROR) return@update it
      val end = if (it.durationMs >= 0) it.durationMs else Long.MAX_VALUE
      val position = positionMs.coerceIn(0, end)
      it.copy(
        positionMs = position,
        status = if (it.status == ENDED && position < end) READY else it.status,
      )
    }

  /** Move the virtual clock: playing, ready, non-buffering players advance, end or loop. */
  fun advance(ms: Long) {
    for ((id, player) in players) {
      val state = player.state
      if (!state.playing || state.buffering || state.status != READY) continue
      val position = state.positionMs + ms
      when {
        state.durationMs < 0 || position < state.durationMs ->
          player.state = state.copy(positionMs = position)
        player.loop ->
          player.state =
            state.copy(positionMs = if (state.durationMs == 0L) 0L else position % state.durationMs)
        else -> {
          player.state = state.copy(positionMs = position)
          end(id)
        }
      }
    }
  }

  fun simulate(request: SimRequest): Failure? {
    if (request.player !in players) return Failure.UNKNOWN_PLAYER
    val status =
      when (request.event) {
        "media.ended" -> ENDED
        "media.error" -> ERROR
        "media.statusChanged" -> request.status?.takeIf { it in SIM_STATUSES }
        else -> null
      }
    if (status == null || (status == ERROR && request.code !in ERROR_CODES)) {
      return Failure.INVALID_ARGS
    }
    request.advanceMs?.let(::advance)
    val player = players.getValue(request.player)
    when (status) {
      BUFFERING -> player.state = player.state.copy(buffering = true)
      READY -> update(request.player) { it.copy(buffering = false, status = READY, error = null) }
      ENDED -> {
        player.state = player.state.copy(buffering = false)
        end(request.player)
      }
      else -> fail(request.player, request.code!!)
    }
    return null
  }

  fun release(player: String): Failure? =
    if (players.remove(player) != null) null else Failure.UNKNOWN_PLAYER

  private fun update(player: String, change: (State) -> State): Failure? {
    val entry = players[player] ?: return Failure.UNKNOWN_PLAYER
    val before = entry.state
    val after = change(before)
    entry.state = after
    if (before.status != after.status || before.playing != after.playing) {
      statusChanged(player, after)
    }
    return null
  }

  private fun end(player: String) {
    val wasEnded = players.getValue(player).state.status == ENDED
    update(player) {
      it.copy(
        playing = false,
        positionMs = if (it.durationMs >= 0) it.durationMs else it.positionMs,
        status = ENDED,
        error = null,
      )
    }
    if (!wasEnded) emitted += Event("media.ended", mapOf("player" to player))
  }

  private fun fail(player: String, code: String) {
    val state = players.getValue(player).state
    val unchanged = state.status == ERROR && state.error == code
    update(player) { it.copy(playing = false, buffering = false, status = ERROR, error = code) }
    if (!unchanged) emitted += Event("media.error", mapOf("player" to player, "code" to code))
  }

  private fun statusChanged(player: String, state: State) {
    emitted +=
      Event(
        "media.statusChanged",
        mapOf(
          "player" to player,
          "status" to state.status,
          "playing" to state.playing,
          "positionMs" to state.positionMs,
        ),
      )
  }

  companion object {
    private const val BUFFERING = "buffering"
    private const val READY = "ready"
    private const val ENDED = "ended"
    private const val ERROR = "error"

    /** The statuses `media.statusChanged` can drive a fake player into. */
    val SIM_STATUSES: List<String> = listOf(BUFFERING, READY, ENDED, ERROR)

    /** The media module's stable error codes, from the contract's `/platform/media` state. */
    val ERROR_CODES: List<String> =
      PrototypePlatformModules.module("media")
        ?.member("state")
        ?.member("error")
        ?.member("value")
        ?.strings("values")
        .orEmpty()
  }
}
