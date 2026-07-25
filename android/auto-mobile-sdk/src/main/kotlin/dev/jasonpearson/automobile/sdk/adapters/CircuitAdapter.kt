package dev.jasonpearson.automobile.sdk.adapters

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.snapshotFlow
import com.slack.circuit.runtime.Navigator
import com.slack.circuit.runtime.screen.Screen
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.NavigationEvent
import dev.jasonpearson.automobile.sdk.NavigationSource
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * Adapter for the Circuit navigation library by Slack.
 *
 * There are three ways to integrate, from most to least automatic:
 * 1. [TrackCircuitNavigation] — a drop-in Composable hook. Register it once with your [Navigator]
 *    and every destination change (goTo/pop/resetRoot) is tracked automatically.
 * 2. [trackScreen] — track a single [Screen] instance; the destination name is derived from the
 *    screen's class.
 * 3. [trackNavigation] — track a raw destination string when you are not holding a [Screen].
 *
 * Automatic usage:
 * ```kotlin
 * @Composable
 * fun App(circuit: Circuit) {
 *   val backStack = rememberSaveableBackStack(root = HomeScreen)
 *   val navigator = rememberCircuitNavigator(backStack)
 *
 *   // Register once — destinations are tracked as the back stack changes.
 *   CircuitAdapter.TrackCircuitNavigation(navigator)
 *
 *   NavigableCircuitContent(navigator, backStack)
 * }
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
   * Composable hook that automatically tracks Circuit navigation for the given [navigator].
   *
   * Observes the top of the navigator's back stack via [snapshotFlow] and emits a [NavigationEvent]
   * whenever the current [Screen] changes — covering forward navigation, pops, and root resets
   * without any per-call bookkeeping. The adapter is started automatically the first time this hook
   * enters composition.
   *
   * Reactive tracking relies on the navigator's back stack being backed by Compose snapshot state,
   * which is the case for the standard `rememberCircuitNavigator`.
   *
   * @param navigator The Circuit [Navigator] whose destinations should be tracked
   * @param extractArguments Optional function to extract arguments from the current [Screen]
   * @param extractMetadata Optional function to extract metadata from the current [Screen]
   */
  @Composable
  fun TrackCircuitNavigation(
    navigator: Navigator,
    extractArguments: (Screen) -> Map<String, Any?> = { emptyMap() },
    extractMetadata: (Screen) -> Map<String, String> = { emptyMap() },
  ) {
    // Enable tracking when first used.
    DisposableEffect(Unit) {
      if (!isActive) start()
      onDispose {}
    }

    LaunchedEffect(navigator) {
      snapshotFlow { navigator.peek() }
        .distinctUntilChanged()
        .collect { screen ->
          if (screen == null) return@collect
          val arguments =
            try {
              extractArguments(screen)
            } catch (e: Exception) {
              emptyMap()
            }
          val metadata =
            try {
              extractMetadata(screen)
            } catch (e: Exception) {
              emptyMap()
            }
          trackScreen(screen, arguments, metadata)
        }
    }
  }

  /**
   * Track a navigation event for a Circuit [Screen]. The destination name is derived from the
   * screen's class name.
   *
   * @param screen The destination screen being navigated to
   * @param arguments Optional navigation arguments
   * @param metadata Optional metadata about the navigation
   */
  fun trackScreen(
    screen: Screen,
    arguments: Map<String, Any?> = emptyMap(),
    metadata: Map<String, String> = emptyMap(),
  ) {
    trackNavigation(circuitDestinationName(screen), arguments, metadata)
  }

  /**
   * Manually track a navigation event in Circuit using a raw destination name.
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

/**
 * Derives a stable, human-readable destination name from a Circuit destination.
 *
 * Prefers the runtime class's simple name (e.g. `ProfileScreen`) and falls back to the fully
 * qualified class name for anonymous destinations whose class has no simple name. The fallback uses
 * `javaClass.name` rather than `toString()` because the default `Any.toString()` is identity-based
 * on the JVM (`ClassName@hashCode`), which would give two instances of the same anonymous screen
 * different names. Accepts [Any] rather than `Screen` so the logic can be unit-tested without
 * depending on Circuit types.
 */
internal fun circuitDestinationName(destination: Any): String =
  destination::class.simpleName ?: destination.javaClass.name
