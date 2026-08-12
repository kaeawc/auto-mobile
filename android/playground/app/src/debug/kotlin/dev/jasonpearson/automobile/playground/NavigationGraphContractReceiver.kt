package dev.jasonpearson.automobile.playground

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.NavigationEvent
import dev.jasonpearson.automobile.sdk.NavigationSource

/** Debug-only trigger for the Android SDK navigation graph contract test. */
class NavigationGraphContractReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_EMIT_SDK_NAVIGATION) return

    val destination = intent.getStringExtra(EXTRA_DESTINATION)?.takeIf { it.isNotBlank() } ?: return
    AutoMobileSDK.notifyNavigationEvent(
      NavigationEvent(
        destination = destination,
        source = NavigationSource.CUSTOM,
      )
    )
  }

  companion object {
    const val ACTION_EMIT_SDK_NAVIGATION =
      "dev.jasonpearson.automobile.playground.action.TEST_EMIT_SDK_NAVIGATION"
    const val EXTRA_DESTINATION = "destination"
  }
}
