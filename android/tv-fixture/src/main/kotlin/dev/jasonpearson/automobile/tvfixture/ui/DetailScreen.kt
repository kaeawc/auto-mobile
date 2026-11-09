package dev.jasonpearson.automobile.tvfixture.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
import dev.jasonpearson.automobile.tvfixture.FixtureCard
import dev.jasonpearson.automobile.tvfixture.TvFixtureCatalog

/** A card's title and detail text, with focus on a Play button that opens the player. */
@Composable
internal fun DetailScreen(card: FixtureCard, onPlay: () -> Unit) {
  val play = remember { FocusRequester() }
  Column(
    modifier = Modifier.fillMaxSize().padding(horizontal = ScreenPadding, vertical = 27.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Text(
      text = card.title,
      style = MaterialTheme.typography.displaySmall,
      modifier = Modifier.testTag("detail_title"),
    )
    Text(text = card.detail, modifier = Modifier.testTag("detail_text"))
    Button(onClick = onPlay, modifier = Modifier.focusRequester(play).testTag("detail_play")) {
      Text(TvFixtureCatalog.PLAY_LABEL)
    }
  }
  InitialFocus(play)
}
