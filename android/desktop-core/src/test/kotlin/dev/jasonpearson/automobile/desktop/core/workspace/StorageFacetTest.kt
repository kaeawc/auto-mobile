package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.datasource.InstalledApp
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.storage.StoragePlatform
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class StorageFacetTest {

  private fun app(pkg: String, foreground: Boolean = false) =
    InstalledApp(packageName = pkg, displayName = pkg, isForeground = foreground)

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
}
