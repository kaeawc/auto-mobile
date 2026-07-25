package dev.jasonpearson.automobile.sdk.adapters

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import com.slack.circuit.runtime.navigation.NavStackList
import com.slack.circuit.runtime.screen.Screen
import com.slack.circuitx.navigation.intercepting.NavigationContext
import com.slack.circuitx.navigation.intercepting.NavigationEventListener
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.NavigationEvent
import dev.jasonpearson.automobile.sdk.NavigationSource

/**
 * Adapter for Circuit navigation library by Slack.
 *
 * Circuit uses a different navigation approach with screens and presenters. Applications using
 * CircuitX can register [rememberCircuitNavigationEventListener] with each
 * `rememberInterceptingNavigator` instance to track committed stack changes automatically.
 *
 * Manual tracking remains available for navigation that CircuitX does not observe:
 * ```kotlin
 * CircuitAdapter.trackNavigation(
 *     destination = screen::class.simpleName ?: "Unknown",
 *     arguments = mapOf("screenParam" to value)
 * )
 * ```
 */
object CircuitAdapter : NavigationFrameworkAdapter {
  private var isActive = false

  override fun start() {
    isActive = true
  }

  override fun stop() {
    isActive = false
  }

  override fun isActive(): Boolean = isActive

  /**
   * Creates a listener for CircuitX
   * [com.slack.circuitx.navigation.intercepting.InterceptingNavigator] instances.
   *
   * Register the returned listener with each navigator whose destinations should be tracked. It
   * reports the initial active screen and each subsequent committed stack change. Extractors use
   * their latest recomposed values without replacing the listener.
   *
   * @param extractArguments Extracts navigation arguments from the active screen.
   * @param extractMetadata Extracts navigation metadata from the active screen.
   */
  @Composable
  fun rememberCircuitNavigationEventListener(
    extractArguments: (Screen) -> Map<String, Any?> = { emptyMap() },
    extractMetadata: (Screen) -> Map<String, String> = { emptyMap() },
  ): NavigationEventListener {
    val currentExtractArguments = rememberUpdatedState(extractArguments)
    val currentExtractMetadata = rememberUpdatedState(extractMetadata)

    if (!isActive) start()

    return remember {
      object : NavigationEventListener {
        override fun onNavStackChanged(
          navStack: NavStackList<Screen>?,
          navigationContext: NavigationContext,
        ) {
          val screen = navStack?.active ?: return
          trackScreen(
            screen = screen,
            arguments = currentExtractArguments.value(screen),
            metadata = currentExtractMetadata.value(screen),
          )
        }
      }
    }
  }

  /**
   * Manually track a Circuit [Screen].
   *
   * @param screen The Circuit screen to track.
   * @param arguments Optional navigation arguments.
   * @param metadata Optional navigation metadata.
   */
  fun trackScreen(
    screen: Screen,
    arguments: Map<String, Any?> = emptyMap(),
    metadata: Map<String, String> = emptyMap(),
  ) {
    trackNavigation(
      destination = screen::class.simpleName ?: screen::class.java.name,
      arguments = arguments,
      metadata = metadata,
    )
  }

  /**
   * Manually track a navigation event in Circuit.
   *
   * @param destination The destination screen name
   * @param arguments Optional navigation arguments
   * @param metadata Optional metadata about the navigation
   */
  fun trackNavigation(
    destination: String,
    arguments: Map<String, Any?> = emptyMap(),
    metadata: Map<String, String> = emptyMap(),
  ) {
    if (!isActive) return

    AutoMobileSDK.notifyNavigationEvent(
      NavigationEvent(
        destination = destination,
        source = NavigationSource.CIRCUIT,
        arguments = arguments,
        metadata = metadata,
      )
    )
  }
}
