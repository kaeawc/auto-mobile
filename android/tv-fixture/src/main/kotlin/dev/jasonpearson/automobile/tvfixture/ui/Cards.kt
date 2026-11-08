package dev.jasonpearson.automobile.tvfixture.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Card
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import dev.jasonpearson.automobile.tvfixture.FixtureCard

/** Card size: about four and a half cards fit a 1080p row, so the rest start off screen. */
private val CardWidth = 196.dp
private val CardHeight = 110.dp
private val CardSpacing = 16.dp
internal val ScreenPadding = 48.dp

/**
 * A horizontally scrolling row of cards tagged [tag]. Moving focus right past the last visible card
 * scrolls the next one into view, which is the D-pad reveal the focus checks rely on.
 */
@Composable
internal fun CardRow(
  tag: String,
  cards: List<FixtureCard>,
  onCardFocused: (String) -> Unit,
  onCardClick: (String) -> Unit,
  firstCardFocus: FocusRequester? = null,
) {
  LazyRow(
    modifier = Modifier.testTag(tag),
    horizontalArrangement = Arrangement.spacedBy(CardSpacing),
    contentPadding = PaddingValues(horizontal = ScreenPadding),
  ) {
    items(cards, key = { it.id }) { card ->
      val focusModifier =
        if (firstCardFocus != null && card == cards.first()) {
          Modifier.focusRequester(firstCardFocus)
        } else {
          Modifier
        }
      FixtureCardView(card, onCardFocused, onCardClick, focusModifier)
    }
  }
}

@Composable
private fun FixtureCardView(
  card: FixtureCard,
  onCardFocused: (String) -> Unit,
  onCardClick: (String) -> Unit,
  modifier: Modifier,
) {
  Card(
    onClick = { onCardClick(card.id) },
    modifier =
      modifier.size(width = CardWidth, height = CardHeight).testTag(card.id).onFocusChanged {
        if (it.isFocused) onCardFocused(card.id)
      },
  ) {
    Text(
      text = card.title,
      style = MaterialTheme.typography.titleMedium,
      modifier = Modifier.padding(12.dp),
    )
  }
}

/** Moves focus to [requester] once the screen has been laid out. */
@Composable
internal fun InitialFocus(requester: FocusRequester) {
  LaunchedEffect(requester) { requester.requestFocus() }
}
