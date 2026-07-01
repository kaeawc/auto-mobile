package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class StorageDashboardUiTest {

  @Test
  fun `shows database tab by default`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        StorageDashboard(
            dataSourceMode = DataSourceMode.Fake,
        )
      }
    }
    onNodeWithText("Databases").assertIsDisplayed()
    onNodeWithText("Key-Value").assertIsDisplayed()
  }

  @Test
  fun `shows both tab icons`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        StorageDashboard(
            dataSourceMode = DataSourceMode.Fake,
        )
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
}
