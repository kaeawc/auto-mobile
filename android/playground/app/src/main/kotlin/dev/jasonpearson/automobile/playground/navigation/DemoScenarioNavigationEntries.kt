package dev.jasonpearson.automobile.playground.navigation

import android.util.Log
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.jasonpearson.automobile.demos.BugReproScreen
import dev.jasonpearson.automobile.demos.ComposeSemanticLinksDemoScreen
import dev.jasonpearson.automobile.demos.ContrastDemoScreen
import dev.jasonpearson.automobile.demos.HandledExceptionDemoScreen
import dev.jasonpearson.automobile.demos.NestedSelectionDemoScreen
import dev.jasonpearson.automobile.demos.NetworkTestScreen
import dev.jasonpearson.automobile.demos.PointerProbeScreen
import dev.jasonpearson.automobile.demos.TapTargetsDemoScreen
import dev.jasonpearson.automobile.demos.XmlSemanticLinksDemoScreen
import dev.jasonpearson.automobile.sdk.adapters.Navigation3Adapter

private const val TAG = "AppNavigation"

internal fun EntryProviderScope<NavKey>.demoScenarioNavigationEntries(state: NavigationState) {
  entry<DemoContrastDestination> { destination -> DemoContrastEntry(destination, state) }
  entry<DemoTapTargetsDestination> { destination -> DemoTapTargetsEntry(destination, state) }
  entry<DemoNestedSelectionDestination> { destination ->
    DemoNestedSelectionEntry(destination, state)
  }
  entry<DemoXmlSemanticLinksDestination> { destination ->
    DemoXmlSemanticLinksEntry(destination, state)
  }
  entry<DemoComposeSemanticLinksDestination> { destination ->
    DemoComposeSemanticLinksEntry(destination, state)
  }
  entry<DemoBugReproDestination> { destination -> DemoBugReproEntry(destination, state) }
  entry<DemoHandledExceptionDestination> { destination ->
    DemoHandledExceptionEntry(destination, state)
  }
  entry<DemoNetworkTestDestination> { destination -> DemoNetworkTestEntry(destination, state) }
  entry<DemoPointerProbeDestination> { destination -> DemoPointerProbeEntry(destination, state) }
}

@Composable
private fun DemoContrastEntry(destination: DemoContrastDestination, state: NavigationState) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to ContrastDemoScreen")
    analyticsTracker.trackScreenView("ContrastDemoScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<DemoContrastDestination>()) {
    ContrastDemoScreen(onNavigateBack = { backStack.popOrGoHome(HomeDestination()) })
  }
}

@Composable
private fun DemoTapTargetsEntry(destination: DemoTapTargetsDestination, state: NavigationState) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to TapTargetsDemoScreen")
    analyticsTracker.trackScreenView("TapTargetsDemoScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<DemoTapTargetsDestination>()) {
    TapTargetsDemoScreen(onNavigateBack = { backStack.popOrGoHome(HomeDestination()) })
  }
}

@Composable
private fun DemoNestedSelectionEntry(
  destination: DemoNestedSelectionDestination,
  state: NavigationState,
) {
  val (backStack, _, _) = state
  Navigation3Adapter.TrackNavigation(destination)
  Box(modifier = Modifier.destinationSemanticModifier<DemoNestedSelectionDestination>()) {
    NestedSelectionDemoScreen(
      onNavigateBack = { backStack.popOrGoHome(HomeDestination()) },
    )
  }
}

@Composable
private fun DemoXmlSemanticLinksEntry(
  destination: DemoXmlSemanticLinksDestination,
  state: NavigationState,
) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to XmlSemanticLinksDemoScreen")
    analyticsTracker.trackScreenView("XmlSemanticLinksDemoScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<DemoXmlSemanticLinksDestination>()) {
    XmlSemanticLinksDemoScreen(
      onNavigateBack = { backStack.popOrGoHome(HomeDestination()) },
    )
  }
}

@Composable
private fun DemoComposeSemanticLinksEntry(
  destination: DemoComposeSemanticLinksDestination,
  state: NavigationState,
) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to ComposeSemanticLinksDemoScreen")
    analyticsTracker.trackScreenView("ComposeSemanticLinksDemoScreen")
  }
  Box(
    modifier = Modifier.destinationSemanticModifier<DemoComposeSemanticLinksDestination>(),
  ) {
    ComposeSemanticLinksDemoScreen(
      onNavigateBack = { backStack.popOrGoHome(HomeDestination()) },
    )
  }
}

@Composable
private fun DemoBugReproEntry(destination: DemoBugReproDestination, state: NavigationState) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to BugReproScreen")
    analyticsTracker.trackScreenView("BugReproScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<DemoBugReproDestination>()) {
    BugReproScreen(onNavigateBack = { backStack.popOrGoHome(HomeDestination()) })
  }
}

@Composable
private fun DemoHandledExceptionEntry(
  destination: DemoHandledExceptionDestination,
  state: NavigationState,
) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to HandledExceptionDemoScreen")
    analyticsTracker.trackScreenView("HandledExceptionDemoScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<DemoHandledExceptionDestination>()) {
    HandledExceptionDemoScreen(
      onNavigateBack = { backStack.popOrGoHome(HomeDestination()) },
    )
  }
}

@Composable
private fun DemoNetworkTestEntry(destination: DemoNetworkTestDestination, state: NavigationState) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to NetworkTestScreen")
    analyticsTracker.trackScreenView("NetworkTestScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<DemoNetworkTestDestination>()) {
    NetworkTestScreen(onNavigateBack = { backStack.popOrGoHome(HomeDestination()) })
  }
}

@Composable
private fun DemoPointerProbeEntry(
  destination: DemoPointerProbeDestination,
  state: NavigationState,
) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to PointerProbeScreen")
    analyticsTracker.trackScreenView("PointerProbeScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<DemoPointerProbeDestination>()) {
    PointerProbeScreen(onNavigateBack = { backStack.popOrGoHome(HomeDestination()) })
  }
}
