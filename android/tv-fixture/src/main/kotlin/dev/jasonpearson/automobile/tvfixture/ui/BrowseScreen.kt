package dev.jasonpearson.automobile.tvfixture.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import dev.jasonpearson.automobile.tvfixture.TvFixtureCatalog

/**
 * Home: navigation buttons and two status lines above the browse rows. Focus starts on the first
 * card of the first row.
 */
@Composable
internal fun BrowseScreen(
  status: String,
  focus: String,
  onNav: (String) -> Unit,
  onCardFocused: (String) -> Unit,
  onCardClick: (String) -> Unit,
) {
  val firstCard = remember { FocusRequester() }
  LazyColumn(
    modifier = Modifier.fillMaxSize().testTag("browse_rows"),
    contentPadding = PaddingValues(vertical = 27.dp),
    verticalArrangement = Arrangement.spacedBy(20.dp),
  ) {
    item(key = "browse_header") { BrowseHeader(status, focus, onNav) }
    items(TvFixtureCatalog.rows, key = { it.id }) { row ->
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
          text = row.title,
          style = MaterialTheme.typography.headlineSmall,
          modifier = Modifier.padding(horizontal = ScreenPadding).testTag("${row.id}_title"),
        )
        CardRow(
          tag = row.id,
          cards = row.cards,
          onCardFocused = onCardFocused,
          onCardClick = onCardClick,
          firstCardFocus = firstCard.takeIf { row == TvFixtureCatalog.rows.first() },
        )
      }
    }
  }
  InitialFocus(firstCard)
}

@Composable
private fun BrowseHeader(status: String, focus: String, onNav: (String) -> Unit) {
  Column(
    modifier = Modifier.padding(horizontal = ScreenPadding),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Row(
      horizontalArrangement = Arrangement.spacedBy(16.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        text = TvFixtureCatalog.APP_TITLE,
        style = MaterialTheme.typography.headlineMedium,
        modifier = Modifier.testTag("app_title"),
      )
      Button(
        onClick = { onNav(TvFixtureCatalog.NAV_SEARCH) },
        modifier = Modifier.testTag(TvFixtureCatalog.NAV_SEARCH),
      ) {
        Text(TvFixtureCatalog.NAV_SEARCH_LABEL)
      }
      Button(
        onClick = { onNav(TvFixtureCatalog.NAV_PLAYER) },
        modifier = Modifier.testTag(TvFixtureCatalog.NAV_PLAYER),
      ) {
        Text(TvFixtureCatalog.NAV_PLAYER_LABEL)
      }
    }
    Text(text = status, modifier = Modifier.testTag("fixture_status"))
    Text(text = focus, modifier = Modifier.testTag("fixture_focus"))
  }
}
