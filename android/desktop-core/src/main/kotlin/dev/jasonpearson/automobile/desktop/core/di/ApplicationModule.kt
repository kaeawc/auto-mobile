package dev.jasonpearson.automobile.desktop.core.di

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpClientFactory
import dev.jasonpearson.automobile.desktop.core.platform.AppVersionProvider
import dev.jasonpearson.automobile.desktop.core.platform.PackagedVersionSource
import dev.jasonpearson.automobile.desktop.core.platform.RuntimeAppVersionProvider
import dev.jasonpearson.automobile.desktop.core.settings.FileSettingsProvider
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.zacsweers.metro.ContributesTo
import dev.zacsweers.metro.Provides

/** Provides application-level dependencies for the desktop app. */
@ContributesTo(AppScope::class)
interface ApplicationModule {

  companion object {

    @Provides
    @SingleIn(AppScope::class)
    fun provideAutoMobileClient(): AutoMobileClient {
      return McpClientFactory.createPreferred()
    }

    @Provides
    @SingleIn(AppScope::class)
    fun provideSettingsProvider(): SettingsProvider {
      // Persistent (file-backed) so the first-run onboarding flag and theme survive restarts.
      // FakeSettingsProvider remains the in-memory implementation used by tests.
      return FileSettingsProvider()
    }

    @Provides
    @SingleIn(AppScope::class)
    fun provideAppVersionProvider(): AppVersionProvider {
      // Reads the build-generated version resource (falling back to the jar manifest); yields
      // AppVersion.Dev for unpackaged runs so update checks no-op in development (#5223).
      return RuntimeAppVersionProvider(PackagedVersionSource())
    }
  }
}
