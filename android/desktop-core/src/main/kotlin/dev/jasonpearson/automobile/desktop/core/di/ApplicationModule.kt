package dev.jasonpearson.automobile.desktop.core.di

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrap
import dev.jasonpearson.automobile.desktop.core.daemon.McpClientFactory
import dev.jasonpearson.automobile.desktop.core.daemon.healthProbeFor
import dev.jasonpearson.automobile.desktop.core.platform.AppVersionProvider
import dev.jasonpearson.automobile.desktop.core.platform.PackagedVersionSource
import dev.jasonpearson.automobile.desktop.core.platform.RuntimeAppVersionProvider
import dev.jasonpearson.automobile.desktop.core.settings.FileSettingsProvider
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.jasonpearson.automobile.desktop.core.update.ConveyorSoftwareUpdateGateway
import dev.jasonpearson.automobile.desktop.core.update.ConveyorUpdateController
import dev.jasonpearson.automobile.desktop.core.update.GitHubReleaseSource
import dev.jasonpearson.automobile.desktop.core.update.RealUpdateController
import dev.jasonpearson.automobile.desktop.core.update.UpdateController
import dev.zacsweers.metro.ContributesTo
import dev.zacsweers.metro.Provides

/** Provides application-level dependencies for the desktop app. */
@ContributesTo(AppScope::class)
interface ApplicationModule {

  companion object {

    @Provides
    @SingleIn(AppScope::class)
    fun provideDaemonBootstrap(): DaemonBootstrap {
      return DaemonBootstrap.create()
    }

    @Provides
    @SingleIn(AppScope::class)
    fun provideAutoMobileClient(daemonBootstrap: DaemonBootstrap): AutoMobileClient {
      // Shares the bootstrap's lifecycle with the daemon client so install/start progress from any
      // trigger (startup bootstrap or a request preflight) reaches the launch surfaces.
      val client = McpClientFactory.createPreferred(daemonBootstrap)
      // Teach recovery to tell a wedged daemon from a reachable one, using the client's own
      // `ide/status` call — the same bounded probe that drives the Red status dot (#6082). Wired
      // here (not in the lifecycle constructor) because the probe needs the very client that is
      // built around the bootstrap's lifecycle. A no-op on an inactive (non-daemon) bootstrap.
      daemonBootstrap.attachHealthProbe(healthProbeFor(client))
      return client
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

    @Provides
    @SingleIn(AppScope::class)
    fun provideUpdateController(appVersionProvider: AppVersionProvider): UpdateController {
      // Inside a Conveyor package, drive updates through Conveyor's control API — it can both check
      // and apply (download + install + restart). Everywhere else (dev, jpackage builds) the
      // gateway
      // is null, so fall back to the GitHub-Releases checker (#5224, #5227). Both are purely
      // reactive
      // — nothing fetches until a caller invokes checkForUpdate().
      val conveyorGateway = ConveyorSoftwareUpdateGateway.createOrNull()
      return if (conveyorGateway != null) {
        ConveyorUpdateController(conveyorGateway)
      } else {
        RealUpdateController(GitHubReleaseSource(), appVersionProvider)
      }
    }
  }
}
