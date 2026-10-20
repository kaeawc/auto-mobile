package dev.jasonpearson.automobile.playground.navigation

import android.util.Log
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.jasonpearson.automobile.login.ui.LoginScreen
import dev.jasonpearson.automobile.onboarding.OnboardingScreen
import dev.jasonpearson.automobile.sdk.adapters.Navigation3Adapter
import dev.jasonpearson.automobile.storage.NavigationTracker

private const val TAG = "AppNavigation"

internal fun EntryProviderScope<NavKey>.authNavigationEntries(state: NavigationState) {
  entry<OnboardingDestination> { destination -> OnboardingEntry(destination, state) }
  entry<LoginDestination> { destination -> LoginEntry(destination, state) }
}

@Composable
private fun OnboardingEntry(destination: OnboardingDestination, state: NavigationState) {
  val (backStack, userPreferences, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to OnboardingScreen")
    analyticsTracker.trackScreenView("OnboardingScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<OnboardingDestination>()) {
    OnboardingScreen(
      onFinish = {
        Log.d(TAG, "Onboarding finished, navigating to LoginScreen")
        userPreferences.hasCompletedOnboarding = true
        NavigationTracker.trackNavigation(
          "OnboardingScreen",
          "LoginScreen",
          "onboarding_finish",
        )
        backStack.clear()
        backStack.add(LoginDestination)
      },
    )
  }
}

@Composable
private fun LoginEntry(destination: LoginDestination, state: NavigationState) {
  val (backStack, userPreferences, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to LoginScreen")
    analyticsTracker.trackScreenView("LoginScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<LoginDestination>()) {
    LoginScreen(
      userPreferences = userPreferences,
      onNavigateToHome = {
        Log.d(TAG, "Login successful, navigating to HomeScreen")
        NavigationTracker.trackNavigation(
          "LoginScreen",
          "HomeScreen",
          "login_success",
        )
        backStack.clear()
        backStack.add(HomeDestination())
      },
      onGuestMode = {
        Log.d(TAG, "Guest mode selected, navigating to HomeScreen")
        userPreferences.isGuestMode = true
        NavigationTracker.trackNavigation("LoginScreen", "HomeScreen", "guest_mode")
        backStack.clear()
        backStack.add(HomeDestination())
      },
    )
  }
}
