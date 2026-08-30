package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import dev.jasonpearson.automobile.desktop.core.datasource.DefaultDataSourceFactory
import dev.jasonpearson.automobile.desktop.core.datasource.InstalledApp
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.AutoMobileGraphProvider
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.platform.AppVersion
import dev.jasonpearson.automobile.desktop.core.platform.AppVersionProvider
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.storage.StoragePlatform
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.core.update.FakeUpdateController
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class StorageFacetTest {

  private fun app(pkg: String, foreground: Boolean = false) =
    InstalledApp(packageName = pkg, displayName = pkg, isForeground = foreground)

  /**
   * A DI graph backed by a [FakeAutoMobileClient] so the dashboard's data load resolves without a
   * socket, keeping these tests deterministic. The stream lifecycle under test comes from the
   * injected [FakeObservationStream], not this client.
   */
  private fun fakeGraph(): AutoMobileGraphProvider {
    val client = FakeAutoMobileClient()
    return object : AutoMobileGraphProvider {
      override val autoMobileClient = client
      override val settingsProvider = FakeSettingsProvider()
      override val dataSourceFactory = DefaultDataSourceFactory(client)
      override val updateController = FakeUpdateController()
      override val appVersionProvider = AppVersionProvider { AppVersion.Dev }
    }
  }

  private fun resolvedApps() = Result.Success(listOf(app("com.example", foreground = true)))

  @Test
  fun `resolves the foreground app package`() {
    val apps = listOf(app("com.a"), app("com.b", foreground = true), app("com.c"))
    assertEquals("com.b", resolveStoragePackage(apps))
  }

  @Test
  fun `falls back to the first app when none is foreground`() {
    assertEquals("com.a", resolveStoragePackage(listOf(app("com.a"), app("com.b"))))
  }

  @Test
  fun `resolves null when the device has no apps`() {
    assertNull(resolveStoragePackage(emptyList()))
  }

  @Test
  fun `maps workspace platform to storage platform`() {
    assertEquals(StoragePlatform.iOS, Platform.Ios.toStoragePlatform())
    assertEquals(StoragePlatform.Android, Platform.Android.toStoragePlatform())
  }

  @Test
  fun `shows the no-app state when the device has no apps`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        StorageFacet(
          column = DeviceColumn(deviceId = "d", name = "Pixel", platform = Platform.Android),
          loadInstalledApps = { Result.Success(emptyList()) },
        )
      }
    }
    waitForIdle()
    onNodeWithText("No app found", substring = true).assertIsDisplayed()
  }

  @Test
  fun `handles an iOS pane without an Android-only gate (#4708)`() = runComposeUiTest {
    // The facet is no longer gated to Android: an iOS column runs the same resolution path.
    setContent {
      MaterialTheme {
        StorageFacet(
          column =
            DeviceColumn(deviceId = "ios-sim-1", name = "iPhone 16", platform = Platform.Ios),
          loadInstalledApps = { Result.Success(emptyList()) },
        )
      }
    }
    waitForIdle()
    onNodeWithText("No app found", substring = true).assertIsDisplayed()
  }

  @Test
  fun `surfaces a retryable error when the app list fails to load`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        StorageFacet(
          column = DeviceColumn(deviceId = "d", name = "Pixel", platform = Platform.Android),
          loadInstalledApps = { Result.Error(RuntimeException("daemon down")) },
        )
      }
    }
    waitForIdle()
    onNodeWithText("daemon down", substring = true).assertIsDisplayed()
    onNodeWithContentDescription("Retry loading apps").assertIsDisplayed()
  }

  // -- Live storage stream seam (#4709): the dashboard is fed a per-pane, device-scoped stream so
  // storage_update frames flow in, mirroring how PerformanceFacet drives its metrics.

  @Test
  fun `connects a UUID-scoped stream while the dashboard is shown and disposes it on removal`() =
    runComposeUiTest {
      val fake = FakeObservationStream()
      val visible = mutableStateOf(true)
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides fakeGraph()) {
          MaterialTheme {
            if (visible.value) {
              StorageFacet(
                column =
                  DeviceColumn(
                    deviceId = "dev-1",
                    name = "Pixel",
                    platform = Platform.Android,
                    deviceSessionUuid = "epoch-a",
                  ),
                loadInstalledApps = { resolvedApps() },
                observationStreamFactory = { fake },
              )
            }
          }
        }
      }
      waitForIdle()
      // Connected exactly once, to this pane's device.
      assertEquals("dev-1", fake.lastConnectedDeviceId)
      assertEquals("epoch-a", fake.lastConnectedDeviceSessionUuid)
      assertEquals(1, fake.connectCallCount)

      // Leaving composition disposes the stream (dispose → disconnect).
      runOnIdle { visible.value = false }
      waitForIdle()
      assertTrue("expected the stream to be disposed on removal", fake.disconnectCallCount >= 1)
    }

  @Test
  fun `does not open a live storage stream when the daemon resource lacks an epoch UUID`() =
    runComposeUiTest {
      val fake = FakeObservationStream()
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides fakeGraph()) {
          MaterialTheme {
            StorageFacet(
              column =
                DeviceColumn(deviceId = "dev-1", name = "Pixel", platform = Platform.Android),
              loadInstalledApps = { resolvedApps() },
              observationStreamFactory = { fake },
            )
          }
        }
      }

      waitForIdle()
      assertEquals(0, fake.connectCallCount)
    }

  @Test
  fun `re-scopes the stream to the new device when the pane device changes`() = runComposeUiTest {
    val fake = FakeObservationStream()
    val deviceId = mutableStateOf("dev-1")
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides fakeGraph()) {
        MaterialTheme {
          StorageFacet(
            column =
              DeviceColumn(
                deviceId = deviceId.value,
                name = "Pixel",
                platform = Platform.Android,
                deviceSessionUuid = "epoch-a",
              ),
            loadInstalledApps = { resolvedApps() },
            observationStreamFactory = { fake },
          )
        }
      }
    }
    waitForIdle()
    assertEquals(1, fake.connectCallCount)

    // A pane pointed at another device must not keep the old device's subscription — panes stay
    // isolated by re-scoping the stream to the new device.
    runOnIdle { deviceId.value = "dev-2" }
    waitForIdle()
    assertEquals("dev-2", fake.lastConnectedDeviceId)
    assertEquals(2, fake.connectCallCount)
    assertTrue(fake.disconnectCallCount >= 1)
  }

  @Test
  fun `reconnects the storage stream after a mid-session drop`() = runComposeUiTest {
    val fake = FakeObservationStream()
    // A gate the test releases to let the single reconnect attempt proceed with zero wall time.
    val backoff = CompletableDeferred<Unit>()
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides fakeGraph()) {
        MaterialTheme {
          StorageFacet(
            column =
              DeviceColumn(
                deviceId = "dev-1",
                name = "Pixel",
                platform = Platform.Android,
                deviceSessionUuid = "epoch-a",
              ),
            loadInstalledApps = { resolvedApps() },
            observationStreamFactory = { fake },
            backoffDelay = { backoff.await() },
            socketAvailable = { true },
          )
        }
      }
    }
    waitForIdle()
    assertEquals(1, fake.connectCallCount)

    // A daemon restart / EOF surfaces as a Disconnected state; the facet must reconnect instead of
    // leaving the inspector's live updates dead until the pane is reopened.
    runOnIdle { fake.emitConnectionState(ConnectionState.Disconnected("Stream ended")) }
    waitForIdle()
    runOnIdle { backoff.complete(Unit) }
    waitForIdle()
    assertEquals("expected the storage facet to reconnect after a drop", 2, fake.connectCallCount)
  }
}
