package dev.jasonpearson.automobile.tvfixture.player

import org.junit.Assert.assertEquals
import org.junit.Test

class PlayerStateTest {
  private val initial = PlayerState()

  @Test
  fun `starts paused at the top of the first track`() {
    assertEquals("Paused", initial.stateLabel)
    assertEquals("Track 1 of 3: Opening Titles", initial.trackLabel)
    assertEquals("0:00 / 3:00", initial.positionLabel)
    assertEquals("Last command: none", initial.lastCommandLabel)
  }

  @Test
  fun `play pause toggles and play and pause are idempotent`() {
    val playing = initial.apply(PlayerCommand.PLAY_PAUSE)
    assertEquals("Playing", playing.stateLabel)
    assertEquals("Last command: playPause", playing.lastCommandLabel)
    assertEquals("Paused", playing.apply(PlayerCommand.PLAY_PAUSE).stateLabel)
    assertEquals("Playing", playing.apply(PlayerCommand.PLAY).stateLabel)
    assertEquals("Paused", initial.apply(PlayerCommand.PAUSE).stateLabel)
    assertEquals("Playing", initial.apply(PlayerCommand.PLAY).stateLabel)
    assertEquals("Paused", playing.apply(PlayerCommand.PAUSE).stateLabel)
  }

  @Test
  fun `seeks move ten seconds and clamp to the track`() {
    val forward = initial.apply(PlayerCommand.FAST_FORWARD).apply(PlayerCommand.FAST_FORWARD)
    assertEquals("0:20 / 3:00", forward.positionLabel)
    assertEquals("0:10 / 3:00", forward.apply(PlayerCommand.REWIND).positionLabel)
    assertEquals(0, initial.apply(PlayerCommand.REWIND).positionSeconds)
    assertEquals(
      180,
      initial.copy(positionSeconds = 175).apply(PlayerCommand.FAST_FORWARD).positionSeconds,
    )
  }

  @Test
  fun `next and previous change track, reset position and clamp to the playlist`() {
    val second = initial.apply(PlayerCommand.FAST_FORWARD).apply(PlayerCommand.NEXT)
    assertEquals("Track 2 of 3: Main Feature", second.trackLabel)
    assertEquals("0:00 / 10:00", second.positionLabel)
    val last = second.apply(PlayerCommand.NEXT).apply(PlayerCommand.NEXT)
    assertEquals(2, last.trackIndex)
    assertEquals(0, initial.apply(PlayerCommand.PREVIOUS).trackIndex)
    val back = last.copy(positionSeconds = 30).apply(PlayerCommand.PREVIOUS)
    assertEquals(1, back.trackIndex)
    assertEquals(0, back.positionSeconds)
    assertEquals("Last command: previous", initial.apply(PlayerCommand.PREVIOUS).lastCommandLabel)
  }

  @Test
  fun `stop pauses and rewinds to the start`() {
    val stopped =
      initial.apply(PlayerCommand.PLAY).apply(PlayerCommand.FAST_FORWARD).apply(PlayerCommand.STOP)
    assertEquals("Paused", stopped.stateLabel)
    assertEquals(0, stopped.positionSeconds)
  }
}
