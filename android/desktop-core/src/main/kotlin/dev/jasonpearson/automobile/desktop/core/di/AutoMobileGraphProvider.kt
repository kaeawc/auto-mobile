package dev.jasonpearson.automobile.desktop.core.di

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceFactory
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider

/**
 * Interface exposing the dependencies the UI layer needs from the DI graph.
 *
 * Implemented by the Metro-generated graph so that Compose code can access graph-provided instances
 * via [LocalAutoMobileGraph].
 */
interface AutoMobileGraphProvider {
  /** The default MCP client for communicating with the AutoMobile daemon. */
  val autoMobileClient: AutoMobileClient

  /** Application settings provider. */
  val settingsProvider: SettingsProvider

  /** Factory for creating data source instances. */
  val dataSourceFactory: DataSourceFactory
}
