package dev.jasonpearson.automobile.playground.navigation

import android.net.Uri
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import dev.jasonpearson.automobile.storage.AnalyticsTracker
import dev.jasonpearson.automobile.storage.UserPreferences

/**
 * Creates a semantic test tag for a navigation destination using its class information. This
 * provides consistent test tags for each screen in the navigation flow.
 *
 * Example: OnboardingDestination -> "navigation.OnboardingDestination"
 */
inline fun <reified T : AppDestination> Modifier.destinationSemanticModifier(): Modifier {
  val destinationClass = T::class.java
  val packageName = destinationClass.`package`?.name?.split(".")?.lastOrNull() ?: "unknown"
  val className = destinationClass.simpleName ?: "unknown"

  val testTag = "$packageName.$className"

  return semantics {
    this.testTag = testTag
    this.testTagsAsResourceId = true
  }
}

/**
 * Creates a semantic test tag for a specific destination instance. This allows for parameterized
 * destinations to include their parameters in the test tag.
 *
 * Example: VideoPlayerDestination(videoId="abc123") ->
 * "navigation.VideoPlayerDestination.video_abc123"
 */
inline fun <reified T : NavKey> Modifier.destinationSemanticModifier(
  customTag: String? = null,
): Modifier {
  val destinationClass = T::class.java
  val packageName = destinationClass.`package`?.name?.split(".")?.lastOrNull() ?: "unknown"
  val className = destinationClass.simpleName ?: "unknown"

  val testTag = buildString {
    append(packageName)
    append('.')
    append(className)
    if (customTag != null) {
      append('.')
      append(customTag)
    }
  }

  return semantics {
    this.testTag = testTag
    this.testTagsAsResourceId = true
  }
}

private const val TAG = "AppNavigation"

/** Determines the start destination based on user state */
fun determineStartDestination(
  hasCompletedOnboarding: Boolean,
  isAuthenticated: Boolean,
): AppDestination {
  return when {
    !hasCompletedOnboarding -> OnboardingDestination
    !isAuthenticated -> LoginDestination
    else -> HomeDestination()
  }
}

/** Determines the start destination when a deep link is present */
fun determineStartDestinationWithDeepLink(
  deepLinkUri: Uri?,
  hasCompletedOnboarding: Boolean,
  isAuthenticated: Boolean,
): AppDestination {
  Log.d(
    TAG,
    "determineStartDestinationWithDeepLink - deepLinkUri: $deepLinkUri, hasCompletedOnboarding: $hasCompletedOnboarding, isAuthenticated: $isAuthenticated",
  )

  return if (deepLinkUri != null) {
    Log.d(TAG, "Processing deep link: $deepLinkUri")
    // Try to parse the deep link to a specific destination first
    val parsedDestination = DeepLinkManager.parseDeepLink(deepLinkUri)
    Log.d(TAG, "Parsed destination from deep link: $parsedDestination")

    if (parsedDestination != null) {
      // Check if the user has proper auth state for the destination
      val finalDestination =
        authorizeStartDestination(parsedDestination, hasCompletedOnboarding, isAuthenticated)
      Log.d(TAG, "Final destination for deep link: $finalDestination")
      finalDestination
    } else {
      Log.d(TAG, "Failed to parse deep link, falling back to auth flow")
      // Fallback to auth flow if deep link parsing fails
      val fallbackDestination = fallbackStartDestination(hasCompletedOnboarding, isAuthenticated)
      Log.d(TAG, "Fallback destination: $fallbackDestination")
      fallbackDestination
    }
  } else {
    Log.d(TAG, "No deep link present, using standard start destination logic")
    val standardDestination = determineStartDestination(hasCompletedOnboarding, isAuthenticated)
    Log.d(TAG, "Standard start destination: $standardDestination")
    standardDestination
  }
}

private fun authorizeStartDestination(
  parsedDestination: AppDestination,
  hasCompletedOnboarding: Boolean,
  isAuthenticated: Boolean,
): AppDestination {
  return when (parsedDestination) {
    is OnboardingDestination -> {
      Log.d(TAG, "Deep link targets onboarding, allowing")
      parsedDestination
    }

    is LoginDestination -> {
      Log.d(TAG, "Deep link targets login, allowing")
      parsedDestination
    }
    else -> {
      // For protected destinations, ensure user is authenticated
      when {
        !hasCompletedOnboarding -> {
          Log.d(
            TAG,
            "Deep link targets protected destination but user hasn't completed onboarding, redirecting to onboarding",
          )
          OnboardingDestination
        }

        !isAuthenticated -> {
          Log.d(
            TAG,
            "Deep link targets protected destination but user not authenticated, redirecting to login",
          )
          LoginDestination
        }

        else -> {
          Log.d(
            TAG,
            "Deep link targets protected destination and user is authenticated, allowing: $parsedDestination",
          )
          parsedDestination
        }
      }
    }
  }
}

private fun fallbackStartDestination(
  hasCompletedOnboarding: Boolean,
  isAuthenticated: Boolean,
): AppDestination {
  return when {
    !hasCompletedOnboarding -> {
      Log.d(TAG, "Fallback: user hasn't completed onboarding")
      OnboardingDestination
    }

    !isAuthenticated -> {
      Log.d(TAG, "Fallback: user not authenticated")
      LoginDestination
    }

    else -> {
      Log.d(TAG, "Fallback: user authenticated, going to home")
      HomeDestination()
    }
  }
}

@Composable
fun AppNavigation(deepLinkUri: Uri? = null, onDeepLinkCallbackSet: ((Uri) -> Unit) -> Unit = {}) {
  val context = LocalContext.current
  val userPreferences = remember { UserPreferences(context) }
  val analyticsTracker = remember { AnalyticsTracker.getInstance() }

  // Determine the start destination based on user state and deep link presence
  val startDestination =
    determineStartDestinationWithDeepLink(
      deepLinkUri = deepLinkUri,
      hasCompletedOnboarding = userPreferences.hasCompletedOnboarding,
      isAuthenticated = userPreferences.isAuthenticated,
    )

  Log.d(TAG, "Determined start destination: $startDestination")

  // Create back stack using nav3 with state restoration
  val backStack = rememberNavBackStack(startDestination)

  val navigationState = NavigationState(backStack, userPreferences, analyticsTracker)
  RegisterNavigationCallbacks(onDeepLinkCallbackSet, navigationState)

  NavDisplay(
    modifier = Modifier.semantics { testTagsAsResourceId = true },
    backStack = backStack,
    onBack = { backStack.popOrGoHome(HomeDestination()) },
    entryDecorators =
      listOf(
        rememberSaveableStateHolderNavEntryDecorator(),
        rememberViewModelStoreNavEntryDecorator(),
      ),
    entryProvider =
      entryProvider {
        authNavigationEntries(navigationState)
        homeNavigationEntry(navigationState)
        mediaNavigationEntries(navigationState)
        settingsNavigationEntry(navigationState)
        demoFlowNavigationEntries(navigationState)
        demoScenarioNavigationEntries(navigationState)
      },
  )
}
