package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.StorageStreamUpdate
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class StorageDashboardUiTest {

  private fun themeUpdate(value: String) =
    StorageStreamUpdate(
      deviceId = "emulator-5554",
      timestamp = 1_000L,
      packageName = "com.example.app",
      fileName = "app_preferences",
      key = "theme",
      value = value,
      valueType = KeyValueType.String,
      sequenceNumber = 1L,
    )

  @Test
  fun `shows database tab by default`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        StorageDashboard(dataSourceMode = DataSourceMode.Fake)
      }
    }
    onNodeWithText("Databases").assertIsDisplayed()
    onNodeWithText("Key-Value").assertIsDisplayed()
  }

  @Test
  fun `shows both tab icons`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        StorageDashboard(dataSourceMode = DataSourceMode.Fake)
      }
    }
    onNodeWithText(StorageTab.Database.icon).assertIsDisplayed()
    onNodeWithText(StorageTab.KeyValue.icon).assertIsDisplayed()
  }

  @Test
  fun `renders with android platform`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        StorageDashboard(
          dataSourceMode = DataSourceMode.Fake,
          platform = StoragePlatform.Android,
        )
      }
    }
    onNodeWithText("Databases").assertIsDisplayed()
  }

  @Test
  fun `renders with ios platform`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        StorageDashboard(
          dataSourceMode = DataSourceMode.Fake,
          platform = StoragePlatform.iOS,
        )
      }
    }
    onNodeWithText("Databases").assertIsDisplayed()
  }

  @Test
  fun `renders with device and package params`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        StorageDashboard(
          dataSourceMode = DataSourceMode.Fake,
          deviceId = "emulator-5554",
          packageName = "com.example.app",
        )
      }
    }
    onNodeWithText("Databases").assertIsDisplayed()
    onNodeWithText("Key-Value").assertIsDisplayed()
  }

  @Test
  fun `a live storage update through the injected stream refreshes the displayed value (#4709)`() =
    runComposeUiTest {
      val stream = FakeObservationStream()
      setContent {
        MaterialTheme {
          StorageDashboard(
            dataSourceMode = DataSourceMode.Fake,
            deviceId = "emulator-5554",
            packageName = "com.example.app",
            observationStreamClient = stream,
          )
        }
      }
      onNodeWithText("Key-Value").performClick()
      // The seeded key-value file loads its "theme" = "dark" entry (String values render quoted).
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("\"dark\"", substring = true).fetchSemanticsNodes().isNotEmpty()
      }

      // A daemon-pushed change to the inspected app's key flows in without reopening the facet.
      runOnIdle { stream.emitStorage(themeUpdate("light")) }
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("\"light\"", substring = true).fetchSemanticsNodes().isNotEmpty()
      }
      onNodeWithText("\"light\"", substring = true).assertIsDisplayed()
    }
}
