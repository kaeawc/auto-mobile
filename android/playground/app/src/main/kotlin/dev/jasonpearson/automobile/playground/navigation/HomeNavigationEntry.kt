package dev.jasonpearson.automobile.playground.navigation

import android.util.Log
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.jasonpearson.automobile.home.HomeNavigation
import dev.jasonpearson.automobile.home.HomeScreen
import dev.jasonpearson.automobile.sdk.adapters.Navigation3Adapter
import dev.jasonpearson.automobile.storage.NavigationTracker

private const val TAG = "AppNavigation"

internal fun EntryProviderScope<NavKey>.homeNavigationEntry(state: NavigationState) {
  entry<HomeDestination> { homeDestination -> HomeEntry(homeDestination, state) }
}

@Composable
private fun HomeEntry(homeDestination: HomeDestination, state: NavigationState) {
  val (_, _, analyticsTracker) = state
  val tabNames = listOf("Discover", "Demos", "Slides", "Settings")
  Navigation3Adapter.TrackNavigation(
    destination = homeDestination,
    extractArguments = {
      mapOf("tab" to (tabNames.getOrNull(it.selectedTab) ?: it.selectedTab))
    },
  )
  LaunchedEffect(Unit) {
    Log.d(
      TAG,
      "Navigated to HomeScreen with selectedTab: ${homeDestination.selectedTab}, selectedSubTab: ${homeDestination.selectedSubTab}",
    )
    analyticsTracker.trackScreenView("HomeScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<HomeDestination>()) {
    HomeScreen(
      initialSelectedTab = homeDestination.selectedTab,
      initialSelectedSubTab = homeDestination.selectedSubTab,
      navigation = homeNavigation(state),
      modifier = Modifier.destinationSemanticModifier<HomeDestination>(),
    )
  }
}

private fun homeNavigation(state: NavigationState): HomeNavigation {
  val backStack = state.backStack
  return HomeNavigation(
    onNavigateToVideoPlayer = { videoId ->
      Log.d(TAG, "Navigating to VideoPlayerScreen with videoId: $videoId")
      NavigationTracker.trackNavigation(
        "HomeScreen",
        "VideoPlayerScreen",
        "video_selection",
      )
      backStack.add(VideoPlayerDestination(videoId))
    },
    onNavigateToDemos = {
      Log.d(TAG, "Navigating to DemoIndexScreen")
      NavigationTracker.trackNavigation(
        "HomeScreen",
        "DemoIndexScreen",
        "demo_selection",
      )
      backStack.add(DemoIndexDestination)
    },
    onNavigateToSlides = { slideIndex ->
      Log.d(TAG, "Navigating to SlidesScreen with slideIndex: $slideIndex")
      NavigationTracker.trackNavigation(
        "HomeScreen",
        "SlidesScreen",
        "slides_selection",
      )
      backStack.add(SlidesDestination(slideIndex))
    },
    onLogout = { logoutFromHome(state) },
    onGuestModeNavigateToLogin = { loginFromGuestHome(state) },
  )
}

private fun logoutFromHome(state: NavigationState) {
  val (backStack, userPreferences, _) = state

  Log.d(TAG, "Logout initiated, navigating to LoginScreen")
  if (userPreferences.isGuestMode) {
    userPreferences.isGuestMode = false
  } else {
    userPreferences.isAuthenticated = false
  }
  NavigationTracker.trackNavigation("HomeScreen", "LoginScreen", "logout")
  backStack.clear()
  backStack.add(LoginDestination)
}

private fun loginFromGuestHome(state: NavigationState) {
  val (backStack, userPreferences, _) = state

  Log.d(TAG, "Guest mode to login, navigating to LoginScreen")
  userPreferences.isGuestMode = false
  NavigationTracker.trackNavigation(
    "HomeScreen",
    "LoginScreen",
    "guest_to_login",
  )
  backStack.clear()
  backStack.add(LoginDestination)
}
