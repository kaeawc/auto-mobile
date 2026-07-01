package dev.jasonpearson.automobile.desktop

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import dev.jasonpearson.automobile.desktop.core.AutoMobileContent
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.platform.NoOpNotificationHandler
import dev.jasonpearson.automobile.desktop.core.platform.SourceFileOpener
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.jasonpearson.automobile.desktop.core.shell.MenuBarActions
import dev.jasonpearson.automobile.desktop.theme.AutoMobileTheme

/**
 * Wraps a [SettingsProvider] so that [themeMode] is backed by Compose snapshot state, enabling
 * recomposition when the user changes the theme in settings.
 */
private class ObservableSettingsProvider(
    private val delegate: SettingsProvider,
) : SettingsProvider by delegate {
  private var _themeMode by mutableStateOf(delegate.themeMode)
  override var themeMode: String
    get() = _themeMode
    set(value) {
      _themeMode = value
      delegate.themeMode = value
    }
}

@Composable
fun AutoMobileDesktopApp(menuBarActions: MenuBarActions = remember { MenuBarActions() }) {
  val graphSettings = LocalAutoMobileGraph.current.settingsProvider
  val settings = remember(graphSettings) { ObservableSettingsProvider(graphSettings) }

  AutoMobileTheme(themeMode = settings.themeMode) {
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
      AutoMobileContent(
          settingsProvider = settings,
          notificationHandler = NoOpNotificationHandler,
          onOpenSource = { fileName, lineNumber, className ->
            SourceFileOpener.open(
                fileName,
                lineNumber,
                className,
                settings.androidIde,
                settings.iosIde,
            )
          },
          menuBarActions = menuBarActions,
      )
    }
  }
}
