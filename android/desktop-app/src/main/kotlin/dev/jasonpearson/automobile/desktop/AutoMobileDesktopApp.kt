package dev.jasonpearson.automobile.desktop

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.jasonpearson.automobile.desktop.core.AutoMobileContent
import dev.jasonpearson.automobile.desktop.core.platform.NoOpNotificationHandler
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.theme.AutoMobileTheme

@Composable
fun AutoMobileDesktopApp() {
  AutoMobileTheme {
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
      AutoMobileContent(
          settingsProvider = FakeSettingsProvider(),
          notificationHandler = NoOpNotificationHandler,
      )
    }
  }
}
