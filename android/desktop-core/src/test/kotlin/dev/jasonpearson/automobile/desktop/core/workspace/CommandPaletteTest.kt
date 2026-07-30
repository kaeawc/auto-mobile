package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.runComposeUiTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class CommandPaletteTest {

  private fun cmd(id: String, label: String) = PaletteCommand(id, label) {}

  private fun column(id: String, name: String, activeTool: Tool? = null) =
    DeviceColumn(deviceId = id, name = name, platform = Platform.Android, activeTool = activeTool)

  @Test
  fun `command-palette shortcut matches K with meta or ctrl only`() {
    assertTrue(isCommandPaletteShortcut(Key.K, isMetaPressed = true, isCtrlPressed = false))
    assertTrue(isCommandPaletteShortcut(Key.K, isMetaPressed = false, isCtrlPressed = true))
    assertTrue(isCommandPaletteShortcut(Key.K, isMetaPressed = true, isCtrlPressed = true))
    assertFalse(isCommandPaletteShortcut(Key.K, isMetaPressed = false, isCtrlPressed = false))
    assertFalse(isCommandPaletteShortcut(Key.J, isMetaPressed = true, isCtrlPressed = false))
    assertFalse(isCommandPaletteShortcut(Key.P, isMetaPressed = false, isCtrlPressed = true))
  }

  @Test
  fun `filter matches label substring case-insensitively and blank returns all`() {
    val commands = listOf(cmd("a", "Open Devices"), cmd("b", "Close Pixel"), cmd("c", "Open Logs"))
    assertEquals(listOf("a", "c"), filterCommands(commands, "OPEN").map { it.id })
    assertEquals(3, filterCommands(commands, "   ").size)
  }

  @Test
  fun `empty state offers only Open Devices`() {
    val commands = buildWorkspaceCommands(WorkspaceUiState.Empty, onOpenPicker = {}, onAction = {})
    assertEquals(listOf("Open Devices"), commands.map { it.label })
  }

  @Test
  fun `content offers per-device and focused-tool commands that dispatch`() {
    val dispatched = mutableListOf<WorkspaceAction>()
    var openedPicker = false
    val state =
      WorkspaceUiState.Content(columns = listOf(column("a", "Pixel 8")), focusedDeviceId = "a")
    val commands =
      buildWorkspaceCommands(
        state,
        onOpenPicker = { openedPicker = true },
        onAction = { dispatched.add(it) },
      )
    val labels = commands.map { it.label }
    assertTrue(labels.containsAll(listOf("Open Devices", "Focus Pixel 8", "Close Pixel 8")))
    assertTrue(labels.contains("Open Logs on Pixel 8"))

    commands.first { it.label == "Open Logs on Pixel 8" }.run()
    assertEquals(WorkspaceAction.SelectTool("a", Tool.Logs), dispatched.last())
    commands.first { it.label == "Open Devices" }.run()
    assertTrue(openedPicker)
  }

  @Test
  fun `compare command appears only with multiple devices and an active tool`() {
    val two =
      WorkspaceUiState.Content(
        columns = listOf(column("a", "Pixel", activeTool = Tool.Logs), column("b", "Tab")),
        focusedDeviceId = "a",
      )
    assertTrue(
      buildWorkspaceCommands(two, {}, {}).any { it.label == "Compare Logs across devices" }
    )
    val one =
      WorkspaceUiState.Content(
        columns = listOf(column("a", "Pixel", activeTool = Tool.Logs)),
        focusedDeviceId = "a",
      )
    assertTrue(buildWorkspaceCommands(one, {}, {}).none { it.label.startsWith("Compare") })
  }

  @Test
  fun `typing filters the list and selecting runs the command then dismisses`() = runComposeUiTest {
    var ran: String? = null
    var dismissed = false
    val commands =
      listOf(
        PaletteCommand("a", "Open Devices") { ran = "a" },
        PaletteCommand("b", "Close Pixel") { ran = "b" },
      )
    setContent { MaterialTheme { CommandPalette(commands, onDismiss = { dismissed = true }) } }
    onNodeWithContentDescription("Command search").assertIsFocused()
    onNodeWithContentDescription("Command search").performTextInput("close")
    onNodeWithText("Open Devices").assertDoesNotExist()
    onNodeWithText("Close Pixel").performClick()
    assertEquals("b", ran)
    assertTrue(dismissed)
  }

  @Test
  fun `arrow down then enter runs the second command and dismisses`() = runComposeUiTest {
    var ran: String? = null
    var dismissed = false
    val commands =
      listOf(
        PaletteCommand("a", "Open Devices") { ran = "a" },
        PaletteCommand("b", "Close Pixel") { ran = "b" },
      )
    setContent { MaterialTheme { CommandPalette(commands, onDismiss = { dismissed = true }) } }
    onNodeWithContentDescription("Command search").assertIsFocused()
    onRoot().performKeyInput {
      pressKey(Key.DirectionDown)
      pressKey(Key.Enter)
    }
    assertEquals("b", ran)
    assertTrue(dismissed)
  }

  @Test
  fun `numpad enter runs the selected command and dismisses`() = runComposeUiTest {
    var ran: String? = null
    var dismissed = false
    val commands =
      listOf(
        PaletteCommand("a", "Open Devices") { ran = "a" },
        PaletteCommand("b", "Close Pixel") { ran = "b" },
      )
    setContent { MaterialTheme { CommandPalette(commands, onDismiss = { dismissed = true }) } }
    onNodeWithContentDescription("Command search").assertIsFocused()
    onRoot().performKeyInput {
      pressKey(Key.DirectionDown)
      pressKey(Key.NumPadEnter)
    }
    assertEquals("b", ran)
    assertTrue(dismissed)
  }

  @Test
  fun `arrow up from the top wraps to the last command`() = runComposeUiTest {
    var ran: String? = null
    val commands =
      listOf(
        PaletteCommand("a", "Open Devices") { ran = "a" },
        PaletteCommand("b", "Close Pixel") { ran = "b" },
        PaletteCommand("c", "Open Logs") { ran = "c" },
      )
    setContent { MaterialTheme { CommandPalette(commands, onDismiss = {}) } }
    onNodeWithContentDescription("Command search").assertIsFocused()
    onRoot().performKeyInput {
      pressKey(Key.DirectionUp)
      pressKey(Key.Enter)
    }
    assertEquals("c", ran)
  }

  @Test
  fun `the highlighted row carries selected semantics and moves with arrow keys`() =
    runComposeUiTest {
      val commands =
        listOf(
          PaletteCommand("a", "Open Devices") {},
          PaletteCommand("b", "Close Pixel") {},
        )
      setContent { MaterialTheme { CommandPalette(commands, onDismiss = {}) } }
      onNodeWithContentDescription("Command search").assertIsFocused()
      onNodeWithText("Open Devices").assertIsSelected()
      onNodeWithText("Close Pixel").assertIsNotSelected()
      onRoot().performKeyInput { pressKey(Key.DirectionDown) }
      onNodeWithText("Close Pixel").assertIsSelected()
      onNodeWithText("Open Devices").assertIsNotSelected()
    }

  @Test
  fun `escape closes the palette`() = runComposeUiTest {
    var dismissed = false
    val commands = listOf(PaletteCommand("a", "Open Devices") {})
    setContent { MaterialTheme { CommandPalette(commands, onDismiss = { dismissed = true }) } }
    onNodeWithContentDescription("Command search").assertIsFocused()
    onRoot().performKeyInput { pressKey(Key.Escape) }
    assertTrue(dismissed)
  }

  @Test
  fun `identically named devices get distinct labels`() {
    val state =
      WorkspaceUiState.Content(
        columns = listOf(column("sim-A", "iPhone 15"), column("sim-B", "iPhone 15")),
        focusedDeviceId = "sim-A",
      )
    val focusLabels =
      buildWorkspaceCommands(state, {}, {}).filter { it.id.startsWith("focus-") }.map { it.label }
    assertEquals(2, focusLabels.size)
    assertEquals(focusLabels.size, focusLabels.toSet().size)
  }

  @Test
  fun `same-name devices whose ids share their final six chars still get distinct labels`() {
    val state =
      WorkspaceUiState.Content(
        columns = listOf(column("A-15-ABCDEF", "iPhone 15"), column("B-15-ABCDEF", "iPhone 15")),
        focusedDeviceId = "A-15-ABCDEF",
      )
    val focusLabels =
      buildWorkspaceCommands(state, {}, {}).filter { it.id.startsWith("focus-") }.map { it.label }
    assertEquals(2, focusLabels.size)
    assertEquals(focusLabels.size, focusLabels.toSet().size)
  }
}
