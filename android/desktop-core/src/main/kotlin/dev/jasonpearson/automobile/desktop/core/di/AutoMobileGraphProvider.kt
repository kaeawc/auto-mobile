package dev.jasonpearson.automobile.desktop.core.di

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrap
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceFactory
import dev.jasonpearson.automobile.desktop.core.platform.AppVersionProvider
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.jasonpearson.automobile.desktop.core.update.UpdateController

/**
 * Interface exposing the dependencies the UI layer needs from the DI graph.
 *
 * Implemented by the Metro-generated graph so that Compose code can access graph-provided instances
 * via [LocalAutoMobileGraph].
 */
interface AutoMobileGraphProvider {
  /** The default MCP client for communicating with the AutoMobile daemon. */
  val autoMobileClient: AutoMobileClient

  /** Observable install/start progress of the shared daemon (drives the launch surfaces). */
  val daemonBootstrap: DaemonBootstrap

  /** Application settings provider. */
  val settingsProvider: SettingsProvider

  /** Factory for creating data source instances. */
  val dataSourceFactory: DataSourceFactory

  /** Checks GitHub Releases for a newer desktop build; drives the status-bar update affordance. */
  val updateController: UpdateController

  /** The running app's own version, used to show "you're on X" and to gate update checks. */
  val appVersionProvider: AppVersionProvider
}
