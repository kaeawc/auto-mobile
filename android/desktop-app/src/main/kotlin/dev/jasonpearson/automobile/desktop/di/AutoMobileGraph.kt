package dev.jasonpearson.automobile.desktop.di

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceFactory
import dev.jasonpearson.automobile.desktop.core.di.AppScope
import dev.jasonpearson.automobile.desktop.core.di.AutoMobileGraphProvider
import dev.jasonpearson.automobile.desktop.core.di.SingleIn
import dev.jasonpearson.automobile.desktop.core.platform.AppVersionProvider
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.jasonpearson.automobile.desktop.core.update.UpdateController
import dev.zacsweers.metro.DependencyGraph

/**
 * Application-level dependency graph for the AutoMobile desktop app.
 *
 * This graph is the root of the dependency tree and lives for the entire app lifecycle. All
 * dependencies contributed with `@ContributesTo(AppScope::class)` will be included here.
 */
@DependencyGraph(scope = AppScope::class)
@SingleIn(AppScope::class)
interface AutoMobileGraph : AutoMobileGraphProvider {

  /** The MCP client for communicating with the AutoMobile daemon. */
  override val autoMobileClient: AutoMobileClient

  /** Application settings provider. */
  override val settingsProvider: SettingsProvider

  /** Factory for creating data source instances. */
  override val dataSourceFactory: DataSourceFactory

  /** Checks GitHub Releases for a newer desktop build (#5224). */
  override val updateController: UpdateController

  /** The running app's own version (#5223). */
  override val appVersionProvider: AppVersionProvider

  /** Factory for creating the graph. Metro generates the implementation. */
  @DependencyGraph.Factory
  fun interface Factory {
    fun create(): AutoMobileGraph
  }
}
