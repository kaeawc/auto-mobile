package dev.jasonpearson.automobile.desktop.core.di

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpClientFactory
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
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
      return FakeSettingsProvider()
    }
  }
}
