package dev.jasonpearson.automobile.desktop

import androidx.compose.runtime.Composable
import dev.jasonpearson.automobile.desktop.core.AutoMobileContent
import dev.jasonpearson.automobile.desktop.core.platform.NoOpNotificationHandler
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.theme.AutoMobileTheme

@Composable
fun AutoMobileDesktopApp() {
  AutoMobileTheme {
    AutoMobileContent(
        settingsProvider = FakeSettingsProvider(),
        notificationHandler = NoOpNotificationHandler,
    )
  }
}
