package dev.jasonpearson.automobile.playground.navigation

import android.net.Uri
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.navigation3.runtime.NavBackStack
import androidx.navigation3.runtime.NavKey
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.adapters.Navigation3Adapter
import dev.jasonpearson.automobile.storage.AnalyticsTracker
import dev.jasonpearson.automobile.storage.UserPreferences

private const val TAG = "AppNavigation"

internal data class NavigationState(
  val backStack: NavBackStack<NavKey>,
  val userPreferences: UserPreferences,
  val analyticsTracker: AnalyticsTracker,
)

@Composable
internal fun RegisterNavigationCallbacks(
  onDeepLinkCallbackSet: ((Uri) -> Unit) -> Unit,
  state: NavigationState,
) {
  val (backStack, userPreferences, analyticsTracker) = state
  // Register a navigation listener to log all navigation events
  LaunchedEffect(Unit) {
    AutoMobileSDK.addNavigationListener { event ->
      Log.d(
        TAG,
        "AutoMobileSDK Navigation Event: destination=${event.destination}, source=${event.source}, arguments=${event.arguments}, metadata=${event.metadata}",
      )
    }
  }

  ObserveNavigationResume(backStack)

  // Set up the deep link callback for runtime navigation
  LaunchedEffect(Unit) {
    Log.d(TAG, "Setting up deep link callback")
    onDeepLinkCallbackSet { uri ->
      Log.d(TAG, "Deep link callback invoked with URI: $uri")
      val parsedDestination = DeepLinkManager.parseDeepLink(uri)
      Log.d(TAG, "Parsed destination: $parsedDestination")

      if (parsedDestination != null) {
        // Check if the user has proper auth state for the destination
        val targetDestination = runtimeDeepLinkDestination(parsedDestination, userPreferences)

        Log.d(TAG, "Navigating to destination: $targetDestination")
        // Clear the back stack and navigate to the deep link destination
        backStack.clear()
        backStack.add(targetDestination)

        // Track the deep link navigation
        analyticsTracker.trackEvent(
          "deep_link_navigation",
          mapOf(
            "uri" to uri.toString(),
            "destination" to targetDestination.toString(),
            "isRuntime" to "true",
          ),
        )
      } else {
        Log.w(TAG, "Failed to parse deep link destination: $uri")
      }
    }
  }
}

@Composable
private fun ObserveNavigationResume(backStack: NavBackStack<NavKey>) {
  // Re-fire current navigation destination on resume (after returning from background)
  val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
  androidx.compose.runtime.DisposableEffect(lifecycleOwner) {
    val observer =
      androidx.lifecycle.LifecycleEventObserver { _, event ->
        if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
          val current = backStack.lastOrNull() ?: return@LifecycleEventObserver
          val name = current::class.simpleName ?: return@LifecycleEventObserver
          Navigation3Adapter.trackManually(name)
        }
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
  }
}

private fun runtimeDeepLinkDestination(
  parsedDestination: AppDestination,
  userPreferences: UserPreferences,
): AppDestination {
  return when (parsedDestination) {
    is OnboardingDestination -> parsedDestination
    is LoginDestination -> parsedDestination
    else -> {
      // For protected destinations, ensure user is authenticated
      when {
        !userPreferences.hasCompletedOnboarding -> {
          Log.d(TAG, "User hasn't completed onboarding, redirecting to onboarding")
          OnboardingDestination
        }

        !userPreferences.isAuthenticated -> {
          Log.d(TAG, "User not authenticated, redirecting to login")
          LoginDestination
        }

        else -> {
          Log.d(TAG, "User authenticated, navigating to: $parsedDestination")
          parsedDestination
        }
      }
    }
  }
}
