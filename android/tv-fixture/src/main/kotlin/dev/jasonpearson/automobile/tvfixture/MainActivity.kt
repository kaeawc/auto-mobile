package dev.jasonpearson.automobile.tvfixture

import android.media.session.MediaController
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.tvfixture.player.FixturePlayerSession
import dev.jasonpearson.automobile.tvfixture.player.PlayerCommand
import dev.jasonpearson.automobile.tvfixture.player.PlayerState
import dev.jasonpearson.automobile.tvfixture.ui.FixtureApp

/**
 * The fixture's only activity. It owns the player and its media session, so media keys work on
 * every screen, and a recreated activity starts the player over from its initial state.
 */
class MainActivity : ComponentActivity() {
  private var player by mutableStateOf(PlayerState())
  private lateinit var session: FixturePlayerSession

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // The SDK reports each screen as a navigation event, which explore and navigateTo rely on.
    AutoMobileSDK.initialize(applicationContext)
    session = FixturePlayerSession(this, ::runCommand)
    session.publish(player)
    session.activate()
    // With a controller set, the window hands unhandled media keys straight to this session
    // instead of whichever session the system picked last.
    mediaController = MediaController(this, session.token)
    setContent { FixtureApp(player = player, onPlayerCommand = ::runCommand) }
  }

  override fun onDestroy() {
    session.release()
    super.onDestroy()
  }

  private fun runCommand(command: PlayerCommand) {
    player = player.apply(command)
    session.publish(player)
  }
}
