package dev.jasonpearson.automobile.tvfixture.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import dev.jasonpearson.automobile.tvfixture.player.PlayerCommand
import dev.jasonpearson.automobile.tvfixture.player.PlayerState

/** One on-screen transport button: its test tag, label and command. */
private data class TransportButton(val tag: String, val label: String, val command: PlayerCommand)

/**
 * The simulated player's state lines and transport buttons. Media keys change the same state, so a
 * key press shows up here exactly as a button press does. Focus starts on Play/Pause.
 */
@Composable
internal fun PlayerScreen(player: PlayerState, onCommand: (PlayerCommand) -> Unit) {
  val playPause = remember { FocusRequester() }
  val buttons =
    listOf(
      TransportButton("player_previous", "Previous", PlayerCommand.PREVIOUS),
      TransportButton("player_rewind", "Rewind", PlayerCommand.REWIND),
      TransportButton(
        PLAY_PAUSE_TAG,
        if (player.isPlaying) "Pause" else "Play",
        PlayerCommand.PLAY_PAUSE,
      ),
      TransportButton("player_fast_forward", "Fast forward", PlayerCommand.FAST_FORWARD),
      TransportButton("player_next", "Next", PlayerCommand.NEXT),
    )
  Column(
    modifier = Modifier.fillMaxSize().padding(horizontal = ScreenPadding, vertical = 27.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Text(
      text = player.trackLabel,
      style = MaterialTheme.typography.headlineMedium,
      modifier = Modifier.testTag("player_track"),
    )
    Text(text = player.stateLabel, modifier = Modifier.testTag("player_state"))
    Text(text = player.positionLabel, modifier = Modifier.testTag("player_position"))
    Text(text = player.lastCommandLabel, modifier = Modifier.testTag("player_last_command"))
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
      buttons.forEach { button ->
        val focus =
          if (button.tag == PLAY_PAUSE_TAG) Modifier.focusRequester(playPause) else Modifier
        Button(onClick = { onCommand(button.command) }, modifier = focus.testTag(button.tag)) {
          Text(button.label)
        }
      }
    }
  }
  InitialFocus(playPause)
}

private const val PLAY_PAUSE_TAG = "player_play_pause"
