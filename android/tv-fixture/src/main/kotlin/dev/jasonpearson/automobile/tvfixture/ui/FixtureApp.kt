package dev.jasonpearson.automobile.tvfixture.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import dev.jasonpearson.automobile.tvfixture.FixtureRoute
import dev.jasonpearson.automobile.tvfixture.FixtureState
import dev.jasonpearson.automobile.tvfixture.TvFixtureCatalog
import dev.jasonpearson.automobile.tvfixture.player.PlayerCommand
import dev.jasonpearson.automobile.tvfixture.player.PlayerState

private val FixtureStateSaver =
  Saver<FixtureState, List<Any>>(save = { it.toSaved() }, restore = FixtureState::fromSaved)

/** Root composable: holds [FixtureState] and routes UI events into its transitions. */
@Composable
fun FixtureApp(player: PlayerState, onPlayerCommand: (PlayerCommand) -> Unit) {
  var state by rememberSaveable(stateSaver = FixtureStateSaver) { mutableStateOf(FixtureState()) }
  val update: (FixtureState.() -> FixtureState) -> Unit = { state = state.it() }
  BackHandler(enabled = state.backStack.canPop) { update { back() } }

  MaterialTheme {
    Surface(modifier = Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
      key(state.backStack.current.route) {
        RouteContent(state, update, player, onPlayerCommand)
      }
    }
  }
}

@Composable
private fun RouteContent(
  state: FixtureState,
  update: (FixtureState.() -> FixtureState) -> Unit,
  player: PlayerState,
  onPlayerCommand: (PlayerCommand) -> Unit,
) {
  val onCardClick: (String) -> Unit = { update { openCard(it) } }
  val onCardFocused: (String) -> Unit = { update { cardFocused(it) } }
  when (val route = state.backStack.current) {
    FixtureRoute.Browse ->
      BrowseScreen(
        status = state.status,
        focus = state.focus,
        onNav = { update { onNav(it) } },
        onCardFocused = onCardFocused,
        onCardClick = onCardClick,
      )
    FixtureRoute.Search ->
      SearchScreen(
        query = state.query,
        summary = state.searchSummary,
        results = state.results,
        onQueryChange = { update { queryChanged(it) } },
        onCardFocused = onCardFocused,
        onCardClick = onCardClick,
      )
    is FixtureRoute.Detail ->
      TvFixtureCatalog.card(route.cardId)?.let { card ->
        DetailScreen(card = card, onPlay = { update { openPlayer() } })
      }
    FixtureRoute.Player -> PlayerScreen(player = player, onCommand = onPlayerCommand)
  }
}
