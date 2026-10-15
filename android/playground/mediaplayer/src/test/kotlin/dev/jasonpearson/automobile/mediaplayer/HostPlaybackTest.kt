package dev.jasonpearson.automobile.mediaplayer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HostPlaybackTest {
  @Test
  fun hostStopPausesPlayingMediaOnce() {
    val player = FakePlayer(State.PLAYING)

    player.onHostStopped()
    player.onHostStopped()

    assertEquals(1, player.pauseCalls)
    assertFalse(player.isPlaying)
    assertFalse(player.playWhenReady)
  }

  @Test
  fun hostStopPausesBufferingMediaWithPlayIntent() {
    val player = FakePlayer(State.BUFFERING)
    assertTrue(player.playWhenReady)
    assertFalse(player.isPlaying)

    player.onHostStopped()
    player.onHostStopped()

    assertEquals(1, player.pauseCalls)
    assertFalse(player.playWhenReady)
    assertEquals(State.PAUSED, player.state)
  }

  @Test
  fun hostStopLeavesAlreadyPausedMediaUnchanged() {
    val player = FakePlayer(State.PAUSED)

    player.onHostStopped()

    assertEquals(0, player.pauseCalls)
    assertFalse(player.isPlaying)
    assertFalse(player.playWhenReady)
    assertEquals(State.PAUSED, player.state)
  }

  @Test
  fun hostStopLeavesIdlePlayerUnchanged() {
    val player = FakePlayer(State.IDLE)

    player.onHostStopped()

    assertEquals(0, player.pauseCalls)
    assertFalse(player.playWhenReady)
    assertEquals(State.IDLE, player.state)
  }

  @Test
  fun hostStopLeavesUninitializedHostUnchanged() {
    val player: HostPlayback? = null

    player.onHostStopped()
  }

  private enum class State {
    PLAYING,
    BUFFERING,
    PAUSED,
    IDLE,
  }

  private class FakePlayer(var state: State) : HostPlayback {
    override val playWhenReady: Boolean
      get() = state == State.PLAYING || state == State.BUFFERING

    val isPlaying: Boolean
      get() = state == State.PLAYING

    var pauseCalls = 0
      private set

    override fun pause() {
      pauseCalls++
      state = State.PAUSED
    }
  }
}
