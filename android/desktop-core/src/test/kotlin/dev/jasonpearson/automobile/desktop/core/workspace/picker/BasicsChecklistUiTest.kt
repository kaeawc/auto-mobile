package dev.jasonpearson.automobile.desktop.core.workspace.picker

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrapState
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonLifecyclePhase
import dev.jasonpearson.automobile.desktop.core.workspace.Platform
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class BasicsChecklistUiTest {

  private val booted = PickerDevice("p8", "Pixel 8", Platform.Android, DeviceState.Booted)

  private fun ComposeUiTest.picker(
    state: DevicePickerUiState,
    bootstrap: DaemonBootstrapState,
    checklist: BasicsChecklistOptions?,
  ) = setContent {
    MaterialTheme {
      DevicePicker(
        options =
          DevicePickerOptions(
            state = state,
            onAction = {},
            onClose = {},
            bootstrapState = bootstrap,
            basicsChecklist = checklist,
            thumbnail = { _, _ -> },
          ),
      )
    }
  }

  @Test
  fun `card shows unticked steps while the daemon is starting`() = runComposeUiTest {
    picker(
      DevicePickerUiState.Loading,
      DaemonBootstrapState.Working(DaemonLifecyclePhase.Verifying),
      BasicsChecklistOptions(deviceObserved = false, onDismiss = {}),
    )
    onNodeWithText("Getting started (0/3)").assertIsDisplayed()
    onNodeWithContentDescription("AutoMobile daemon is ready: not yet").assertIsDisplayed()
    onNodeWithContentDescription("A booted device is visible: not yet").assertIsDisplayed()
    onNodeWithContentDescription("A device is observed: not yet").assertIsDisplayed()
  }

  @Test
  fun `card ticks from loaded picker state and an observed workspace`() = runComposeUiTest {
    picker(
      DevicePickerUiState.Content(listOf(booted)),
      DaemonBootstrapState.Ready(restarted = false),
      BasicsChecklistOptions(deviceObserved = true, onDismiss = {}),
    )
    onNodeWithText("Getting started (3/3)").assertIsDisplayed()
    onNodeWithContentDescription("AutoMobile daemon is ready: done").assertIsDisplayed()
    onNodeWithContentDescription("A booted device is visible: done").assertIsDisplayed()
    onNodeWithContentDescription("A device is observed: done").assertIsDisplayed()
    // The grid still renders under the card.
    onNodeWithContentDescription("Observe Pixel 8").assertIsDisplayed()
  }

  @Test
  fun `dismiss invokes the host callback and the host can hide the card`() = runComposeUiTest {
    var dismissed = false
    setContent {
      var visible by remember { mutableStateOf(true) }
      MaterialTheme {
        DevicePicker(
          options =
            DevicePickerOptions(
              state = DevicePickerUiState.Content(listOf(booted)),
              onAction = {},
              onClose = {},
              basicsChecklist =
                if (visible) {
                  BasicsChecklistOptions(
                    deviceObserved = false,
                    onDismiss = {
                      dismissed = true
                      visible = false
                    },
                  )
                } else {
                  null
                },
              thumbnail = { _, _ -> },
            ),
        )
      }
    }
    onNodeWithContentDescription("Dismiss getting started checklist").performClick()
    assertTrue(dismissed)
    onNodeWithText("Getting started", substring = true).assertDoesNotExist()
  }

  @Test
  fun `no card when the host offers none`() = runComposeUiTest {
    picker(DevicePickerUiState.Content(listOf(booted)), DaemonBootstrapState.Inactive, null)
    onNodeWithText("Getting started", substring = true).assertDoesNotExist()
    onNodeWithContentDescription("Observe Pixel 8").assertIsDisplayed()
  }
}
