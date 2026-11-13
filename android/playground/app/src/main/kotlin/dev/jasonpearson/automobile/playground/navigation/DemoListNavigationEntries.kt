package dev.jasonpearson.automobile.playground.navigation

import android.util.Log
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.jasonpearson.automobile.demos.ControlShapesScreen
import dev.jasonpearson.automobile.demos.SharedRowIdListScreen
import dev.jasonpearson.automobile.sdk.adapters.Navigation3Adapter

private const val TAG = "AppNavigation"

internal fun EntryProviderScope<NavKey>.demoListNavigationEntries(state: NavigationState) {
  entry<DemoSharedRowIdListDestination> { destination ->
    DemoSharedRowIdListEntry(destination, state)
  }
  entry<DemoControlShapesDestination> { destination ->
    DemoControlShapesEntry(destination, state)
  }
}

@Composable
private fun DemoSharedRowIdListEntry(
  destination: DemoSharedRowIdListDestination,
  state: NavigationState,
) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to SharedRowIdListScreen")
    analyticsTracker.trackScreenView("SharedRowIdListScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<DemoSharedRowIdListDestination>()) {
    SharedRowIdListScreen(onNavigateBack = { backStack.popOrGoHome(HomeDestination()) })
  }
}

@Composable
private fun DemoControlShapesEntry(
  destination: DemoControlShapesDestination,
  state: NavigationState,
) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to ControlShapesScreen")
    analyticsTracker.trackScreenView("ControlShapesScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<DemoControlShapesDestination>()) {
    ControlShapesScreen(onNavigateBack = { backStack.popOrGoHome(HomeDestination()) })
  }
}
