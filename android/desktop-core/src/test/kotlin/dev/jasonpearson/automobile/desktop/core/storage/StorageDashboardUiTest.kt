package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
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

  @Test
  fun `a live update preserves the draft for the entry being edited`() = runComposeUiTest {
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
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("theme").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("theme").performClick()
    onNodeWithText("\u270E").performClick()
    onNodeWithText("dark").performTextReplacement("draft-value")

    runOnIdle { stream.emitStorage(themeUpdate("light")) }

    onNodeWithText("draft-value").assertIsDisplayed()
  }

  @Test
  fun `subscribes each loaded key-value file and releases every subscription on dispose (#4709)`() =
    runComposeUiTest {
      val stream = FakeObservationStream()
      var show by mutableStateOf(true)
      setContent {
        MaterialTheme {
          if (show) {
            StorageDashboard(
              dataSourceMode = DataSourceMode.Fake,
              deviceId = "emulator-5554",
              packageName = "com.example.app",
              observationStreamClient = stream,
            )
          }
        }
      }

      // Connecting the stream is not enough: the facet must register a device-side content observer
      // per loaded file, or the daemon never emits storage_update frames for external writes.
      waitUntil(timeoutMillis = 5_000) {
        stream.storageSubscriptions.any {
          it.packageName == "com.example.app" && it.fileName == "app_preferences"
        }
      }

      // Leaving composition must release every subscription (DisposableEffect onDispose).
      runOnIdle { show = false }
      waitUntil(timeoutMillis = 5_000) { stream.storageSubscriptions.isEmpty() }
    }

  @Test
  fun `keeps the user's selected file when a live update rebuilds the list (#4709)`() =
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

      // Select the second seeded file (default selection is the first). "new_chat_ui" is a key
      // unique
      // to feature_flags, so it appearing proves that file's entries are shown.
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("feature_flags", substring = true).fetchSemanticsNodes().isNotEmpty()
      }
      onNodeWithText("feature_flags", substring = true).performClick()
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("new_chat_ui", substring = true).fetchSemanticsNodes().isNotEmpty()
      }

      // A live update to a DIFFERENT file (app_preferences) rebuilds keyValueFiles. Selection is
      // tracked by stable path, so the inspector must stay on feature_flags rather than snapping
      // back
      // to the first file and hiding what the user was viewing.
      runOnIdle { stream.emitStorage(themeUpdate("light")) }
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("new_chat_ui", substring = true).fetchSemanticsNodes().isNotEmpty()
      }
      onNodeWithText("new_chat_ui", substring = true).assertIsDisplayed()
    }
}
