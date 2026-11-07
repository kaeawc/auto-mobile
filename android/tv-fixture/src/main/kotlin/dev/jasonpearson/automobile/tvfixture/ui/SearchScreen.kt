package dev.jasonpearson.automobile.tvfixture.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import dev.jasonpearson.automobile.tvfixture.FixtureState
import dev.jasonpearson.automobile.tvfixture.TvFixtureCatalog

/** A search field over every card title, with matching cards in one row below it. */
@Composable
internal fun SearchScreen(
  state: FixtureState,
  onQueryChange: (String) -> Unit,
  onCardFocused: (String) -> Unit,
  onCardClick: (String) -> Unit,
) {
  val field = remember { FocusRequester() }
  Column(
    modifier = Modifier.fillMaxSize().padding(vertical = 27.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Column(
      modifier = Modifier.padding(horizontal = ScreenPadding),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      SearchField(state.query, onQueryChange, field)
      Text(text = state.searchSummary, modifier = Modifier.testTag("search_summary"))
    }
    CardRow(
      tag = "search_results",
      cards = state.results,
      onCardFocused = onCardFocused,
      onCardClick = onCardClick,
    )
  }
  InitialFocus(field)
}

@Composable
private fun SearchField(query: String, onQueryChange: (String) -> Unit, focus: FocusRequester) {
  val colors = MaterialTheme.colorScheme
  BasicTextField(
    value = query,
    onValueChange = onQueryChange,
    singleLine = true,
    textStyle = MaterialTheme.typography.titleLarge.copy(color = colors.onSurface),
    cursorBrush = SolidColor(colors.onSurface),
    modifier =
      Modifier.width(480.dp)
        .border(2.dp, colors.border, MaterialTheme.shapes.small)
        .focusRequester(focus)
        .testTag("search_field"),
    decorationBox = { inner ->
      Box(modifier = Modifier.padding(12.dp)) {
        if (query.isEmpty()) {
          Text(text = TvFixtureCatalog.SEARCH_HINT, color = colors.onSurfaceVariant)
        }
        inner()
      }
    },
  )
}
