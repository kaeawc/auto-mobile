package dev.jasonpearson.automobile.desktop.core.di

import androidx.compose.runtime.staticCompositionLocalOf
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrap
import dev.jasonpearson.automobile.desktop.core.daemon.McpClientFactory
import dev.jasonpearson.automobile.desktop.core.datasource.DefaultDataSourceFactory
import dev.jasonpearson.automobile.desktop.core.platform.PackagedVersionSource
import dev.jasonpearson.automobile.desktop.core.platform.RuntimeAppVersionProvider
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.update.ConveyorSoftwareUpdateGateway
import dev.jasonpearson.automobile.desktop.core.update.ConveyorUpdateController
import dev.jasonpearson.automobile.desktop.core.update.GitHubReleaseSource
import dev.jasonpearson.automobile.desktop.core.update.RealUpdateController

/**
 * CompositionLocal providing the DI graph to the Compose UI tree.
 *
 * When no graph is explicitly provided (e.g. in the IDE plugin), a default provider is used that
 * creates instances via factories — matching the pre-DI behavior.
 */
val LocalAutoMobileGraph =
  staticCompositionLocalOf<AutoMobileGraphProvider> {
    val bootstrap = DaemonBootstrap.create()
    val client = McpClientFactory.createPreferred(bootstrap)
    val versionProvider = RuntimeAppVersionProvider(PackagedVersionSource())
    object : AutoMobileGraphProvider {
      override val autoMobileClient = client
      override val daemonBootstrap = bootstrap
      override val settingsProvider = FakeSettingsProvider()
      override val dataSourceFactory = DefaultDataSourceFactory(client)
      override val appVersionProvider = versionProvider
      override val updateController =
        ConveyorSoftwareUpdateGateway.createOrNull()?.let { ConveyorUpdateController(it) }
          ?: RealUpdateController(GitHubReleaseSource(), versionProvider)
    }
  }
