package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class DeviceColumnHeaderTest {
  @Test
  fun `same-named columns show distinct tab titles and actions`() = runComposeUiTest {
    val columns =
      listOf(
        DeviceColumn("sim-A", "iPhone", Platform.Ios),
        DeviceColumn("sim-B", "iPhone", Platform.Ios),
      )
    val labels = disambiguateLabels(columns, DeviceColumn::deviceId, DeviceColumn::name)
    setContent {
      MaterialTheme {
        Column {
          columns.forEach { column ->
            DeviceColumnHeader(column, labels.getValue(column.deviceId), onAction = {})
          }
        }
      }
    }
    onNodeWithText("iPhone (A)").assertIsDisplayed()
    onNodeWithText("iPhone (B)").assertIsDisplayed()
    onNodeWithContentDescription("Close iPhone (A)").assertIsDisplayed()
    onNodeWithContentDescription("Close iPhone (B)").assertIsDisplayed()
  }
}
