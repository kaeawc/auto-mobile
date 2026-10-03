package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.datasource.InstalledApp
import dev.jasonpearson.automobile.desktop.core.mcp.BootedDevice
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceType
import dev.jasonpearson.automobile.desktop.core.mcp.McpConnectionType
import dev.jasonpearson.automobile.desktop.core.mcp.McpProcess
import kotlin.test.assertEquals
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class LeftSidebarPanelUiTest {
  private val devices =
    listOf(
        BootedDevice(
          "pixel-runtime",
          "Pixel",
          DeviceType.AndroidEmulator,
          connectedAt = 0,
          stableId = "pixel-avd",
        ),
        BootedDevice(
          "phone-runtime",
          "iPhone",
          DeviceType.iOSSimulator,
          connectedAt = 0,
          stableId = "phone-image",
        ),
      )
      .map { it.toSidebarDeviceInfo() }

  @Composable
  private fun Sidebar(
    mode: DataSourceMode = DataSourceMode.Real,
    process: McpProcess? = null,
    onModeChanged: (DataSourceMode) -> Unit = {},
    onRetry: () -> Unit = {},
    onSelect: (String, String?) -> Unit = { _, _ -> },
    onKill: (String) -> Unit = {},
    onSettings: () -> Unit = {},
    onApp: (String?) -> Unit = {},
  ) {
    MaterialTheme {
      LeftSidebarPanel(
        dataSourceMode = mode,
        onDataSourceModeChanged = onModeChanged,
        onDeviceSelected = onSelect,
        onProcessConnected = { error("Host-owned connection must not be overwritten") },
        connectedProcess = process,
        activeDeviceId = "pixel-runtime",
        suppressAutoSelect = true,
        bootedDevices = devices,
        onRetryDetection = onRetry,
        onKillDevice = onKill,
        onOpenSettings = onSettings,
        installedApps = listOf(InstalledApp("dev.example.app", "Example", false)),
        selectedAppId = "dev.example.app",
        onAppSelected = onApp,
        daemonStatusProvider = { null },
        modifier = Modifier.width(320.dp),
      )
    }
  }

  @Test
  fun `panel renders its sections and Settings`() = runComposeUiTest {
    var settings = 0
    setContent { Sidebar(onSettings = { settings++ }) }
    onNodeWithText("MCP Connection").assertIsDisplayed()
    onNodeWithText("Daemon Status").assertIsDisplayed()
    onNodeWithText("Devices").performScrollTo().assertIsDisplayed()
    onNodeWithText("App Filter").performScrollTo().assertIsDisplayed()
    onNodeWithText("Settings", substring = true).performScrollTo().performClick()
    assertEquals(1, settings)
  }

  @Test
  fun `Real and Fake toggles dispatch and disconnected Real exposes retry`() = runComposeUiTest {
    val mode = mutableStateOf(DataSourceMode.Real)
    val changes = mutableListOf<DataSourceMode>()
    var retries = 0
    setContent {
      Sidebar(
        mode = mode.value,
        onModeChanged = {
          changes += it
          mode.value = it
        },
        onRetry = { retries++ },
      )
    }
    onNodeWithText("Not connected").assertIsDisplayed()
    onNodeWithText("Retry Detection").performClick()
    assertEquals(1, retries)
    onNodeWithText("Fake").performClick()
    onNodeWithText("Retry Detection").assertDoesNotExist()
    onNodeWithText("Real").performClick()
    onNodeWithText("Retry Detection").assertIsDisplayed()
    assertEquals(listOf(DataSourceMode.Fake, DataSourceMode.Real), changes)
  }

  @Test
  fun `host connection name and PID render without detection or retry`() = runComposeUiTest {
    setContent { Sidebar(process = McpProcess(1234, "Host daemon", McpConnectionType.UnixSocket)) }
    onNodeWithText("Connected: Host daemon").assertIsDisplayed()
    onNodeWithText("PID: 1234").assertIsDisplayed()
    onNodeWithText("Not connected").assertDoesNotExist()
    onNodeWithText("Retry Detection").assertDoesNotExist()
  }

  @Test
  fun `active device is selected and selection and kill use runtime IDs`() = runComposeUiTest {
    var selected: Pair<String, String?>? = null
    var killed: String? = null
    setContent {
      Sidebar(onSelect = { id, name -> selected = id to name }, onKill = { killed = it })
    }
    onNodeWithText("Pixel").performScrollTo().assertIsSelected()
    onNodeWithText("iPhone").performScrollTo().assertIsNotSelected().performClick()
    assertEquals("phone-runtime" to "iPhone", selected)
    onNodeWithContentDescription("Kill iPhone").performScrollTo().performClick()
    assertEquals("phone-runtime", killed)
  }

  @Test
  fun `app filter selection and clearing remain reachable`() = runComposeUiTest {
    val selectedApps = mutableListOf<String?>()
    setContent { Sidebar(onApp = { selectedApps += it }) }
    onNodeWithText("Example").performScrollTo().performClick()
    onNodeWithText("Clear selection").performScrollTo().performClick()
    assertEquals(listOf("dev.example.app", null), selectedApps)
  }
}
