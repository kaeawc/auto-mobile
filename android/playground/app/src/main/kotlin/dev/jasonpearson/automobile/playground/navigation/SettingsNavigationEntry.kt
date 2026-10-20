package dev.jasonpearson.automobile.playground.navigation

import android.util.Log
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.jasonpearson.automobile.sdk.adapters.Navigation3Adapter
import dev.jasonpearson.automobile.settings.SettingsScreen
import dev.jasonpearson.automobile.storage.NavigationTracker

private const val TAG = "AppNavigation"

internal fun EntryProviderScope<NavKey>.settingsNavigationEntry(state: NavigationState) {
  entry<SettingsDestination> { destination -> SettingsEntry(destination, state) }
}

@Composable
private fun SettingsEntry(destination: SettingsDestination, state: NavigationState) {
  val (backStack, userPreferences, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to SettingsScreen")
    analyticsTracker.trackScreenView("SettingsScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<SettingsDestination>()) {
    SettingsScreen(
      onLogout = {
        Log.d(TAG, "Logout initiated from settings, navigating to LoginScreen")
        if (userPreferences.isGuestMode) {
          userPreferences.isGuestMode = false
        } else {
          userPreferences.isAuthenticated = false
        }
        NavigationTracker.trackNavigation("SettingsScreen", "LoginScreen", "logout")
        backStack.clear()
        backStack.add(LoginDestination)
      },
      onGuestModeNavigateToLogin = {
        Log.d(TAG, "Guest mode to login from settings, navigating to LoginScreen")
        userPreferences.isGuestMode = false
        NavigationTracker.trackNavigation(
          "SettingsScreen",
          "LoginScreen",
          "guest_to_login",
        )
        backStack.clear()
        backStack.add(LoginDestination)
      },
    )
  }
}
