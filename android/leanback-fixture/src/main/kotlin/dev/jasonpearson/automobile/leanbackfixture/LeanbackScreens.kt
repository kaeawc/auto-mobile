package dev.jasonpearson.automobile.leanbackfixture

import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.NavigationEvent
import dev.jasonpearson.automobile.sdk.NavigationSource

/** A fixture screen as the AutoMobile SDK reports it. Screen names are a contract. */
data class LeanbackScreen(val name: String, val arguments: Map<String, String> = emptyMap()) {
  companion object {
    const val BROWSE = "BrowseDestination"
    const val DETAIL = "DetailDestination"

    val Browse = LeanbackScreen(BROWSE)

    /** The detail screen; a missing card id reports no arguments, like the fallback detail. */
    fun detail(cardId: String?): LeanbackScreen =
      LeanbackScreen(DETAIL, cardId?.let { mapOf("cardId" to it) }.orEmpty())
  }
}

/** Reports the screen the fixture shows, so `explore` can record it and `navigateTo` replay it. */
fun interface ScreenTracker {
  fun onScreen(screen: LeanbackScreen)
}

/** Emits each screen as an AutoMobile SDK navigation event named [LeanbackScreen.name]. */
object SdkScreenTracker : ScreenTracker {
  override fun onScreen(screen: LeanbackScreen) {
    AutoMobileSDK.notifyNavigationEvent(
      NavigationEvent(
        destination = screen.name,
        source = NavigationSource.ACTIVITY,
        arguments = screen.arguments,
      ),
    )
  }
}
