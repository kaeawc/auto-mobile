package dev.jasonpearson.automobile.tvfixture.player

import dev.jasonpearson.automobile.tvfixture.FixtureTrack
import dev.jasonpearson.automobile.tvfixture.TvFixtureCatalog

/** A player command. [label] matches the `pressButton` button name that sends the media key. */
enum class PlayerCommand(val label: String) {
  PLAY("play"),
  PAUSE("pause"),
  PLAY_PAUSE("playPause"),
  STOP("stop"),
  FAST_FORWARD("fastForward"),
  REWIND("rewind"),
  NEXT("next"),
  PREVIOUS("previous"),
}

/**
 * The simulated player. Nothing decodes or ticks: the position moves only on a seek, so every
 * command has one exact result a check can assert.
 */
data class PlayerState(
  val trackIndex: Int = 0,
  val positionSeconds: Int = 0,
  val isPlaying: Boolean = false,
  val lastCommand: PlayerCommand? = null,
) {
  val track: FixtureTrack
    get() = TvFixtureCatalog.tracks[trackIndex]

  val stateLabel: String
    get() = if (isPlaying) PLAYING else PAUSED

  val trackLabel: String
    get() = "Track ${trackIndex + 1} of ${TvFixtureCatalog.tracks.size}: ${track.title}"

  val positionLabel: String
    get() = "${clock(positionSeconds)} / ${clock(track.durationSeconds)}"

  val lastCommandLabel: String
    get() = "Last command: ${lastCommand?.label ?: "none"}"

  /** Applies [command]; seeks clamp to the track and track changes clamp to the playlist. */
  fun apply(command: PlayerCommand): PlayerState {
    val step = TvFixtureCatalog.SEEK_STEP_SECONDS
    val lastTrack = TvFixtureCatalog.tracks.lastIndex
    val next =
      when (command) {
        PlayerCommand.PLAY -> copy(isPlaying = true)
        PlayerCommand.PAUSE -> copy(isPlaying = false)
        PlayerCommand.PLAY_PAUSE -> copy(isPlaying = !isPlaying)
        PlayerCommand.STOP -> copy(isPlaying = false, positionSeconds = 0)
        PlayerCommand.FAST_FORWARD ->
          copy(positionSeconds = (positionSeconds + step).coerceAtMost(track.durationSeconds))
        PlayerCommand.REWIND -> copy(positionSeconds = (positionSeconds - step).coerceAtLeast(0))
        PlayerCommand.NEXT ->
          copy(trackIndex = (trackIndex + 1).coerceAtMost(lastTrack), positionSeconds = 0)
        PlayerCommand.PREVIOUS ->
          copy(trackIndex = (trackIndex - 1).coerceAtLeast(0), positionSeconds = 0)
      }
    return next.copy(lastCommand = command)
  }

  companion object {
    const val PLAYING = "Playing"
    const val PAUSED = "Paused"
    private const val SECONDS_PER_MINUTE = 60

    fun clock(seconds: Int): String =
      "${seconds / SECONDS_PER_MINUTE}:${(seconds % SECONDS_PER_MINUTE).toString().padStart(2, '0')}"
  }
}
