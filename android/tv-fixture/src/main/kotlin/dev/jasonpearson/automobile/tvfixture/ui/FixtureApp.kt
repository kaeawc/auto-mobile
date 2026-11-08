package dev.jasonpearson.automobile.tvfixture.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import dev.jasonpearson.automobile.tvfixture.FixtureRoute
import dev.jasonpearson.automobile.tvfixture.FixtureState
import dev.jasonpearson.automobile.tvfixture.ScreenTracker
import dev.jasonpearson.automobile.tvfixture.SdkScreenTracker
import dev.jasonpearson.automobile.tvfixture.TvFixtureCatalog
import dev.jasonpearson.automobile.tvfixture.player.PlayerCommand
import dev.jasonpearson.automobile.tvfixture.player.PlayerState

private val FixtureStateSaver =
  Saver<FixtureState, List<Any>>(save = { it.toSaved() }, restore = FixtureState::fromSaved)

/**
 * Root composable: holds [FixtureState], routes UI events into its transitions and reports each
 * shown screen to [screenTracker].
 */
@Composable
fun FixtureApp(
  player: PlayerState,
  onPlayerCommand: (PlayerCommand) -> Unit,
  screenTracker: ScreenTracker = SdkScreenTracker,
) {
  var state by rememberSaveable(stateSaver = FixtureStateSaver) { mutableStateOf(FixtureState()) }
  val update: (FixtureState.() -> FixtureState) -> Unit = { state = state.it() }
  BackHandler(enabled = state.backStack.canPop) { update { back() } }
  TrackScreen(state.backStack.current, screenTracker)

  MaterialTheme {
    Surface(modifier = Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
      key(state.backStack.current.route) {
        RouteContent(state, update, player, onPlayerCommand)
      }
    }
  }
}

/**
 * Reports [route] when it is shown and again on every resume, so the SDK knows the current screen
 * after the app returns from the background.
 */
@Composable
private fun TrackScreen(route: FixtureRoute, screenTracker: ScreenTracker) {
  val currentRoute by rememberUpdatedState(route)
  LaunchedEffect(route) { screenTracker.onScreen(route) }
  val lifecycleOwner = LocalLifecycleOwner.current
  DisposableEffect(lifecycleOwner, screenTracker) {
    var resumedOnce = false
    val observer = LifecycleEventObserver { _, event ->
      if (event != Lifecycle.Event.ON_RESUME) return@LifecycleEventObserver
      // The first resume follows composition, which already reported the route.
      if (resumedOnce) screenTracker.onScreen(currentRoute)
      resumedOnce = true
    }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
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
        state = state,
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
