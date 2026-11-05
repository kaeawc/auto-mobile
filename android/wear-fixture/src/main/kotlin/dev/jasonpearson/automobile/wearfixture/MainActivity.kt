package dev.jasonpearson.automobile.wearfixture

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.wearfixture.notification.FixtureNotifications
import dev.jasonpearson.automobile.wearfixture.ui.FixtureApp

/** The fixture's only activity. Tile, complication and notification taps all land here. */
class MainActivity : ComponentActivity() {
  private var launch by mutableStateOf(LaunchEvent(0, LaunchRequest()))

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // A recreated activity keeps its saved back stack instead of replaying the launch intent.
    if (savedInstanceState == null) launch = LaunchEvent(1, intent.toLaunchRequest())
    val notifications = FixtureNotifications(this)
    setContent { FixtureApp(launch = launch, notifications = notifications) }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    launch = LaunchEvent(launch.sequence + 1, intent.toLaunchRequest())
  }

  private fun Intent.toLaunchRequest() =
    LaunchRequest(
      itemId = getStringExtra(LaunchRequest.EXTRA_ITEM_ID),
      notificationActionId = getStringExtra(LaunchRequest.EXTRA_NOTIFICATION_ACTION),
    )
}

/** A launch request plus a sequence number, so the same request delivered twice applies twice. */
data class LaunchEvent(val sequence: Int, val request: LaunchRequest)
