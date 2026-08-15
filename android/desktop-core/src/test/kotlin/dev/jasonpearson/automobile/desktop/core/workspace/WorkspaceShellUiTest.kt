package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ScreenshotStreamUpdate
import dev.jasonpearson.automobile.desktop.core.update.ReleaseAsset
import dev.jasonpearson.automobile.desktop.core.update.UpdateStatus
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class WorkspaceShellUiTest {

  private fun col(id: String, name: String, platform: Platform = Platform.Android) =
    DeviceColumn(deviceId = id, name = name, platform = platform)

  @Test
  fun `top bar exposes a command-palette trigger`() = runComposeUiTest {
    var opened = false
    setContent {
      MaterialTheme {
        WorkspaceShell(
          state = WorkspaceUiState.Empty,
          onAction = {},
          onOpenPicker = {},
          onOpenPalette = { opened = true },
        )
      }
    }
    onNodeWithContentDescription("Open command palette").performClick()
    assertTrue(opened)
  }

  private val availableUpdate =
    UpdateStatus.UpdateAvailable(
      version = "0.0.53",
      asset = ReleaseAsset("AutoMobile-0.0.53-macos.dmg", "https://x/dmg", 1),
      releaseNotesUrl = "https://notes",
    )

  @Test
  fun `top bar shows the update pill only when an update is available`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        WorkspaceShell(
          state = WorkspaceUiState.Empty,
          onAction = {},
          onOpenPicker = {},
          updateStatus = availableUpdate,
        )
      }
    }
    onNodeWithText("Update ready").assertIsDisplayed()
  }

  @Test
  fun `top bar hides the update pill for every non-available state`() {
    for (hidden in
      listOf(
        UpdateStatus.Idle,
        UpdateStatus.Checking,
        UpdateStatus.UpToDate,
        UpdateStatus.Failed("boom"),
      )) {
      runComposeUiTest {
        setContent {
          MaterialTheme {
            WorkspaceShell(
              state = WorkspaceUiState.Empty,
              onAction = {},
              onOpenPicker = {},
              updateStatus = hidden,
            )
          }
        }
        onNodeWithText("Update ready").assertDoesNotExist()
      }
    }
  }

  @Test
  fun `clicking the update pill invokes onUpdateClick`() = runComposeUiTest {
    var clicks = 0
    setContent {
      MaterialTheme {
        WorkspaceShell(
          state = WorkspaceUiState.Empty,
          onAction = {},
          onOpenPicker = {},
          updateStatus = availableUpdate,
          onUpdateClick = { clicks++ },
        )
      }
    }
    onNodeWithText("Update ready").performClick()
    assertEquals(1, clicks)
  }

  @Test
  fun `empty state prompts to open Devices`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        WorkspaceShell(state = WorkspaceUiState.Empty, onAction = {}, onOpenPicker = {})
      }
    }
    onNodeWithText("No devices observed", substring = true).assertIsDisplayed()
    onNodeWithContentDescription("Open Devices").assertIsDisplayed()
  }

  @Test
  fun `empty state Open Devices click invokes callback`() = runComposeUiTest {
    var opened = false
    setContent {
      MaterialTheme {
        WorkspaceShell(
          state = WorkspaceUiState.Empty,
          onAction = {},
          onOpenPicker = { opened = true },
        )
      }
    }
    onNodeWithContentDescription("Open Devices").performClick()
    assertTrue(opened)
  }

  @Test
  fun `content renders the device chip header with tools and close`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithText("Pixel 8").assertIsDisplayed()
    onNodeWithContentDescription("Input mode").assertIsDisplayed()
    onNodeWithContentDescription("Inspect mode").assertIsDisplayed()
    onNodeWithContentDescription("Navigation Pixel 8").assertIsDisplayed()
    onNodeWithContentDescription("Performance Pixel 8").assertIsDisplayed()
    onNodeWithContentDescription("Close Pixel 8").assertIsDisplayed()
  }

  @Test
  fun `clicking close emits CloseDevice for that column`() = runComposeUiTest {
    var action: WorkspaceAction? = null
    val state =
      WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
    setContent {
      MaterialTheme { WorkspaceShell(state = state, onAction = { action = it }, onOpenPicker = {}) }
    }
    onNodeWithContentDescription("Close Pixel 8").performClick()
    assertEquals(WorkspaceAction.CloseDevice("a"), action)
  }

  @Test
  fun `clicking a pane emits FocusDevice for that column`() = runComposeUiTest {
    // Device control is focus-gated (only the focused pane arms + accepts input), so the user must
    // be able to move focus by clicking a pane. Clicking anywhere in the unfocused pane 'b' focuses
    // it; without this every non-focused video pane would be a dead mirror (#5221 review).
    val actions = mutableListOf<WorkspaceAction>()
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel 8"), col("b", "iPhone 15", Platform.Ios)),
        focusedDeviceId = "a",
      )
    setContent {
      MaterialTheme {
        WorkspaceShell(state = state, onAction = { actions += it }, onOpenPicker = {})
      }
    }
    onNodeWithText("iPhone 15").performClick()
    assertTrue(WorkspaceAction.FocusDevice("b") in actions)
  }

  @Test
  fun `two devices render both chips`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel 8"), col("b", "iPhone 15", Platform.Ios)),
        focusedDeviceId = "a",
      )
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithText("Pixel 8").assertIsDisplayed()
    onNodeWithText("iPhone 15").assertIsDisplayed()
  }

  @Test
  fun `pane renders rotate screenshot and snapshot controls`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithContentDescription("Rotate Pixel 8").assertIsDisplayed()
    onNodeWithContentDescription("Screenshot Pixel 8").assertIsDisplayed()
    onNodeWithContentDescription("Snapshot Pixel 8").assertIsDisplayed()
  }

  @Test
  fun `Unlock control appears only when the device is locked`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel 8").copy(locked = true)),
        focusedDeviceId = "a",
      )
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithContentDescription("Unlock Pixel 8").assertIsDisplayed()
  }

  @Test
  fun `Unlock control is absent when the device is unlocked`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithContentDescription("Unlock Pixel 8").assertDoesNotExist()
  }

  @Test
  fun `clicking a device-mutating control dispatches RunControl for that column`() =
    runComposeUiTest {
      var action: WorkspaceAction? = null
      val state =
        WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
      setContent {
        MaterialTheme {
          WorkspaceShell(state = state, onAction = { action = it }, onOpenPicker = {})
        }
      }
      onNodeWithContentDescription("Snapshot Pixel 8").performClick()
      assertEquals(WorkspaceAction.RunControl("a", EmulatorControl.Snapshot), action)
    }

  @Test
  fun `clicking Screenshot captures a frame, saves it, and confirms in the pane`() =
    runComposeUiTest {
      val onePxPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
      val fake = FakeObservationStream()
      var savedDeviceName: String? = null
      var savedBytes: ByteArray? = null
      var dispatched: WorkspaceAction? = null
      val state =
        WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
      setContent {
        MaterialTheme {
          WorkspaceShell(
            state = state,
            onAction = { dispatched = it },
            onOpenPicker = {},
            observationStreamFactory = { fake },
            screenshotSaver =
              ScreenshotSaver { name, bytes ->
                savedDeviceName = name
                savedBytes = bytes
                "/tmp/shots/$name.png"
              },
          )
        }
      }

      onNodeWithContentDescription("Screenshot Pixel 8").performClick()

      // Screenshot is NOT a RunControl device mutation — it requests an observation on the stream.
      waitUntil(timeoutMillis = 5_000L) { fake.observationRequestCount == 1 }
      assertEquals(null, dispatched)
      assertEquals("a", fake.lastConnectedDeviceId)
      assertEquals("a", fake.lastObservationDeviceId)

      // The returned frame's PNG bytes are written via the saver, and the pane confirms where.
      fake.emitScreenshot(ScreenshotStreamUpdate("a", 0L, onePxPng, 1, 1))
      waitUntil(timeoutMillis = 5_000L) { savedBytes != null }
      assertEquals("Pixel 8", savedDeviceName)
      assertEquals(Base64.getDecoder().decode(onePxPng).toList(), savedBytes!!.toList())
      onNodeWithContentDescription("Screenshot status Pixel 8").assertIsDisplayed()
    }

  @Test
  fun `Locale control opens a picker and selecting a locale dispatches SetLocale`() =
    runComposeUiTest {
      var action: WorkspaceAction? = null
      val state =
        WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
      setContent {
        MaterialTheme {
          WorkspaceShell(state = state, onAction = { action = it }, onOpenPicker = {})
        }
      }
      onNodeWithContentDescription("Locale Pixel 8").performClick()
      onNodeWithContentDescription("Locale Spanish Pixel 8").performClick()
      assertEquals(WorkspaceAction.SetLocale("a", "es-ES"), action)
    }

  @Test
  fun `a device nav button in the command bar dispatches PressDeviceButton`() = runComposeUiTest {
    var action: WorkspaceAction? = null
    val state =
      WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
    setContent {
      MaterialTheme {
        WorkspaceShell(state = state, onAction = { action = it }, onOpenPicker = {})
      }
    }
    // Buttons are surfaced directly in the command bar now (no More overflow menu).
    // Power shows on Android — a hardware key adb can press.
    onNodeWithContentDescription("Power Pixel 8").assertIsDisplayed()
    onNodeWithContentDescription("Home Pixel 8").performClick()
    assertEquals(WorkspaceAction.PressDeviceButton("a", DeviceButton.Home), action)
  }

  @Test
  fun `iOS command bar offers the navigation buttons but hides simulator-incompatible Power`() =
    runComposeUiTest {
      val state =
        WorkspaceUiState.Content(
          columns = listOf(col("a", "iPhone 15", Platform.Ios)),
          focusedDeviceId = "a",
        )
      setContent {
        MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) }
      }
      // Home/Back/Recent route through CtrlProxy on iOS; Power is physical-device-only.
      onNodeWithContentDescription("Home iPhone 15").assertIsDisplayed()
      onNodeWithContentDescription("Back iPhone 15").assertIsDisplayed()
      onNodeWithContentDescription("Recent apps iPhone 15").assertIsDisplayed()
      onNodeWithContentDescription("Power iPhone 15").assertDoesNotExist()
    }

  @Test
  fun `physical iOS offers Power and hides Locale`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "iPhone 15", Platform.Ios).copy(isVirtual = false)),
        focusedDeviceId = "a",
      )
    setContent {
      MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) }
    }

    onNodeWithContentDescription("Locale iPhone 15").assertDoesNotExist()
    onNodeWithContentDescription("Power iPhone 15").assertIsDisplayed()
  }

  @Test
  fun `iOS simulator offers Locale and hides Power`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "iPhone 15", Platform.Ios).copy(isVirtual = true)),
        focusedDeviceId = "a",
      )
    setContent {
      MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) }
    }

    onNodeWithContentDescription("Locale iPhone 15").assertIsDisplayed()
    onNodeWithContentDescription("Power iPhone 15").assertDoesNotExist()
  }

  @Test
  fun `active tool renders a docked facet with a close control`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel 8").copy(activeTool = Tool.Logs)),
        focusedDeviceId = "a",
      )
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithContentDescription("Close Logs facet on Pixel 8").assertIsDisplayed()
  }

  @Test
  fun `no active tool renders no facet`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithContentDescription("Close Logs facet on Pixel 8").assertDoesNotExist()
  }

  @Test
  fun `facet close deselects the active tool`() = runComposeUiTest {
    var action: WorkspaceAction? = null
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel 8").copy(activeTool = Tool.Logs)),
        focusedDeviceId = "a",
      )
    setContent {
      MaterialTheme { WorkspaceShell(state = state, onAction = { action = it }, onOpenPicker = {}) }
    }
    onNodeWithContentDescription("Close Logs facet on Pixel 8").performClick()
    assertEquals(WorkspaceAction.SelectTool("a", null), action)
  }

  @Test
  fun `re-tapping the active tool toggles it off`() = runComposeUiTest {
    var action: WorkspaceAction? = null
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel 8").copy(activeTool = Tool.Logs)),
        focusedDeviceId = "a",
      )
    setContent {
      MaterialTheme { WorkspaceShell(state = state, onAction = { action = it }, onOpenPicker = {}) }
    }
    onNodeWithContentDescription("Logs Pixel 8").performClick()
    assertEquals(WorkspaceAction.SelectTool("a", null), action)
  }

  @Test
  fun `tapping an inactive tool selects it`() = runComposeUiTest {
    var action: WorkspaceAction? = null
    val state =
      WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
    setContent {
      MaterialTheme { WorkspaceShell(state = state, onAction = { action = it }, onOpenPicker = {}) }
    }
    onNodeWithContentDescription("Storage Pixel 8").performClick()
    assertEquals(WorkspaceAction.SelectTool("a", Tool.Storage), action)
  }

  @Test
  fun `facet renders the injected facetContent for the active tool`() = runComposeUiTest {
    var received: Pair<String, Tool>? = null
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel 8").copy(activeTool = Tool.Logs)),
        focusedDeviceId = "a",
      )
    setContent {
      MaterialTheme {
        WorkspaceShell(
          state = state,
          onAction = {},
          onOpenPicker = {},
          facetContent = { column, tool ->
            received = column.deviceId to tool
            Text("facet-slot:${tool.label}")
          },
        )
      }
    }
    onNodeWithText("facet-slot:Logs").assertIsDisplayed()
    assertEquals("a" to Tool.Logs, received)
  }

  @Test
  fun `diff control appears in a facet only with multiple devices`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(
        columns =
          listOf(
            col("a", "Pixel 8").copy(activeTool = Tool.Logs),
            col("b", "iPhone 15", Platform.Ios),
          ),
        focusedDeviceId = "a",
      )
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithContentDescription("Open Logs on all devices").assertIsDisplayed()
  }

  @Test
  fun `diff control is absent with a single device`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel 8").copy(activeTool = Tool.Logs)),
        focusedDeviceId = "a",
      )
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithContentDescription("Open Logs on all devices").assertDoesNotExist()
  }

  @Test
  fun `clicking diff dispatches DiffTool for the facet's tool`() = runComposeUiTest {
    var action: WorkspaceAction? = null
    val state =
      WorkspaceUiState.Content(
        columns =
          listOf(
            col("a", "Pixel 8").copy(activeTool = Tool.Logs),
            col("b", "iPhone 15", Platform.Ios),
          ),
        focusedDeviceId = "a",
      )
    setContent {
      MaterialTheme { WorkspaceShell(state = state, onAction = { action = it }, onOpenPicker = {}) }
    }
    onNodeWithContentDescription("Open Logs on all devices").performClick()
    assertEquals(WorkspaceAction.DiffTool(Tool.Logs), action)
  }

  @Test
  fun `default facetContent shows the coming-soon placeholder`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel 8").copy(activeTool = Tool.Performance)),
        focusedDeviceId = "a",
      )
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithText("Performance — coming soon", substring = true).assertIsDisplayed()
  }

  @Test
  fun `Inspect mode renders the injected inspect content in place of the stream`() =
    runComposeUiTest {
      val state =
        WorkspaceUiState.Content(
          columns = listOf(col("a", "Pixel 8").copy(mode = InteractionMode.Inspect)),
          focusedDeviceId = "a",
        )
      setContent {
        MaterialTheme {
          WorkspaceShell(
            state = state,
            onAction = {},
            onOpenPicker = {},
            inspectContent = { column -> Text("inspect-slot:${column.deviceId}") },
          )
        }
      }
      onNodeWithText("inspect-slot:a").assertIsDisplayed()
      // The device stream is replaced by the inspector while in Inspect mode.
      onNodeWithText("stream").assertDoesNotExist()
    }

  @Test
  fun `Input mode renders the injected stream content per pane device`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel 8"), col("b", "Pixel 9")),
        focusedDeviceId = "a",
      )
    setContent {
      MaterialTheme {
        WorkspaceShell(
          state = state,
          onAction = {},
          onOpenPicker = {},
          streamContent = { column -> Text("stream-slot:${column.deviceId}") },
        )
      }
    }
    onNodeWithText("stream-slot:a").assertIsDisplayed()
    onNodeWithText("stream-slot:b").assertIsDisplayed()
    // The injected body replaces the default placeholder.
    onNodeWithText("stream").assertDoesNotExist()
  }

  @Test
  fun `Inspect mode does not render the injected stream content`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel 8").copy(mode = InteractionMode.Inspect)),
        focusedDeviceId = "a",
      )
    setContent {
      MaterialTheme {
        WorkspaceShell(
          state = state,
          onAction = {},
          onOpenPicker = {},
          inspectContent = { Text("inspect-slot") },
          streamContent = { Text("stream-slot") },
        )
      }
    }
    onNodeWithText("inspect-slot").assertIsDisplayed()
    onNodeWithText("stream-slot").assertDoesNotExist()
  }

  @Test
  fun `Input mode renders the stream and not the inspect content`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
    setContent {
      MaterialTheme {
        WorkspaceShell(
          state = state,
          onAction = {},
          onOpenPicker = {},
          inspectContent = { Text("inspect-slot") },
        )
      }
    }
    onNodeWithText("stream").assertIsDisplayed()
    onNodeWithText("inspect-slot").assertDoesNotExist()
  }

  @Test
  fun `toggling Inspect back to Input swaps the stream back in`() = runComposeUiTest {
    val mode = mutableStateOf(InteractionMode.Inspect)
    setContent {
      MaterialTheme {
        val state =
          WorkspaceUiState.Content(
            columns = listOf(col("a", "Pixel 8").copy(mode = mode.value)),
            focusedDeviceId = "a",
          )
        WorkspaceShell(
          state = state,
          onAction = {},
          onOpenPicker = {},
          inspectContent = { Text("inspect-slot") },
        )
      }
    }
    onNodeWithText("inspect-slot").assertIsDisplayed()
    onNodeWithText("stream").assertDoesNotExist()
    runOnIdle { mode.value = InteractionMode.Input }
    onNodeWithText("inspect-slot").assertDoesNotExist()
    onNodeWithText("stream").assertIsDisplayed()
  }

  @Test
  fun `green status shows no inline detail line`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        WorkspaceShell(
          state = WorkspaceUiState.Empty,
          onAction = {},
          onOpenPicker = {},
          status = WorkspaceStatus.Green,
          statusDetail = "Daemon reconnecting",
        )
      }
    }
    // "Expands only when not green": the detail line stays hidden even if a detail is supplied.
    onNodeWithContentDescription("Status detail: Daemon reconnecting").assertDoesNotExist()
  }

  @Test
  fun `non-green status shows the inline detail line`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        WorkspaceShell(
          state = WorkspaceUiState.Empty,
          onAction = {},
          onOpenPicker = {},
          status = WorkspaceStatus.Yellow,
          statusDetail = "Daemon reconnecting",
        )
      }
    }
    onNodeWithContentDescription("Status detail: Daemon reconnecting").assertIsDisplayed()
  }

  @Test
  fun `clicking the status dot opens the health sheet`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        WorkspaceShell(
          state = WorkspaceUiState.Empty,
          onAction = {},
          onOpenPicker = {},
          status = WorkspaceStatus.Green,
          healthSheetContent = { Text("fake-health-body") },
        )
      }
    }
    onNodeWithText("fake-health-body").assertDoesNotExist()
    onNodeWithContentDescription("Status: Green").performClick()
    onNodeWithContentDescription("Health sheet").assertIsDisplayed()
    onNodeWithText("fake-health-body").assertIsDisplayed()
  }

  @Test
  fun `closing the health sheet dismisses it`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        WorkspaceShell(
          state = WorkspaceUiState.Empty,
          onAction = {},
          onOpenPicker = {},
          status = WorkspaceStatus.Red,
          statusDetail = "Device offline",
          healthSheetContent = { Text("fake-health-body") },
        )
      }
    }
    onNodeWithContentDescription("Status: Red").performClick()
    onNodeWithText("fake-health-body").assertIsDisplayed()
    onNodeWithContentDescription("Close health sheet").performClick()
    onNodeWithText("fake-health-body").assertDoesNotExist()
  }

  @Test
  fun `clicking the inline detail line also opens the health sheet`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        WorkspaceShell(
          state = WorkspaceUiState.Empty,
          onAction = {},
          onOpenPicker = {},
          status = WorkspaceStatus.Yellow,
          statusDetail = "Daemon reconnecting",
          healthSheetContent = { Text("fake-health-body") },
        )
      }
    }
    onNodeWithContentDescription("Status detail: Daemon reconnecting").performClick()
    onNodeWithText("fake-health-body").assertIsDisplayed()
  }

  @Test
  fun `empty state offers a Browse navigation history affordance`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        WorkspaceShell(state = WorkspaceUiState.Empty, onAction = {}, onOpenPicker = {})
      }
    }
    onNodeWithContentDescription("Browse navigation history").assertIsDisplayed()
  }

  @Test
  fun `Browse navigation history opens the offline browse overlay`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        WorkspaceShell(
          state = WorkspaceUiState.Empty,
          onAction = {},
          onOpenPicker = {},
          offlineBrowseContent = { Text("offline-browse-body") },
        )
      }
    }
    // Overlay body is not present until the affordance is clicked.
    onNodeWithContentDescription("Browse navigation history").performClick()
    onNodeWithText("offline-browse-body").assertIsDisplayed()
  }
}
