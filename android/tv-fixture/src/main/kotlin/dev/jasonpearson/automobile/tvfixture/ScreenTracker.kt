package dev.jasonpearson.automobile.tvfixture

import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.NavigationEvent
import dev.jasonpearson.automobile.sdk.NavigationSource

/** Reports the screen the fixture shows, so `explore` can record it and `navigateTo` replay it. */
fun interface ScreenTracker {
  fun onScreen(route: FixtureRoute)
}

/** Emits each screen as an AutoMobile SDK navigation event named [FixtureRoute.screenName]. */
object SdkScreenTracker : ScreenTracker {
  override fun onScreen(route: FixtureRoute) {
    AutoMobileSDK.notifyNavigationEvent(
      NavigationEvent(
        destination = route.screenName,
        source = NavigationSource.COMPOSE_NAVIGATION,
        arguments = route.arguments,
      ),
    )
  }
}
