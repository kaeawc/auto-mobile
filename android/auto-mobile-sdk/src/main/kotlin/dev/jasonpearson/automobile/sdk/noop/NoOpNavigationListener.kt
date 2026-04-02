package dev.jasonpearson.automobile.sdk.noop

import dev.jasonpearson.automobile.sdk.NavigationEvent
import dev.jasonpearson.automobile.sdk.NavigationListener

/** Silent [NavigationListener] that ignores all navigation events. */
object NoOpNavigationListener : NavigationListener {
  override fun onNavigationEvent(event: NavigationEvent) = Unit
}
