package dev.jasonpearson.automobile.desktop.core.snapshot

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceSnapshotConfig
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceSnapshotMetadata
import dev.jasonpearson.automobile.desktop.core.daemon.FakeDeviceSnapshotActions
import dev.jasonpearson.automobile.desktop.core.daemon.FakeDeviceSnapshotConfigClient
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class SnapshotsDashboardUiTest {

  private fun snapshot(name: String) =
    DeviceSnapshotMetadata(
      snapshotName = name,
      deviceId = "emulator-5554",
      deviceName = "Pixel 8",
      snapshotType = "full",
      sizeBytes = 2_500_000,
      createdAt = "2026-07-19T00:00:00Z",
    )

  @Test
  fun `lists captured snapshots`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        SnapshotsDashboard(
          actions = FakeDeviceSnapshotActions(listOf(snapshot("nightly"))),
          configClient = FakeDeviceSnapshotConfigClient(),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("Device Snapshots").assertIsDisplayed()
    onNodeWithText("nightly").assertIsDisplayed()
  }

  @Test
  fun `prompts for a device when none is selected`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        SnapshotsDashboard(
          actions = FakeDeviceSnapshotActions(),
          configClient = FakeDeviceSnapshotConfigClient(),
          activeDeviceId = null,
        )
      }
    }

    onNodeWithText("Select a device to capture or restore snapshots.").assertIsDisplayed()
  }

  @Test
  fun `shows the empty state when nothing has been captured`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        SnapshotsDashboard(
          actions = FakeDeviceSnapshotActions(),
          configClient = FakeDeviceSnapshotConfigClient(),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("No snapshots captured yet.").assertIsDisplayed()
  }

  @Test
  fun `renders the retention budget from the config socket`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        SnapshotsDashboard(
          actions = FakeDeviceSnapshotActions(),
          configClient =
            FakeDeviceSnapshotConfigClient(DeviceSnapshotConfig(maxArchiveSizeMb = 4096)),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("Archive budget 4096 MB", substring = true).assertIsDisplayed()
  }

  @Test
  fun `still lists snapshots when the config socket is unavailable`() = runComposeUiTest {
    // A daemon predating device-snapshot.sock must not blank out the archive.
    setContent {
      MaterialTheme {
        SnapshotsDashboard(
          actions = FakeDeviceSnapshotActions(listOf(snapshot("nightly"))),
          configClient = FakeDeviceSnapshotConfigClient(available = false),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("nightly").assertIsDisplayed()
    onNodeWithText("Archive budget", substring = true).assertDoesNotExist()
  }

  @Test
  fun `renders with no daemon clients at all`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        SnapshotsDashboard(actions = null, configClient = null, activeDeviceId = null)
      }
    }

    onNodeWithText("Device Snapshots").assertIsDisplayed()
    onNodeWithText("No snapshots captured yet.").assertIsDisplayed()
  }

  @Test
  fun `capture adds a snapshot and reports it`() = runComposeUiTest {
    val actions = FakeDeviceSnapshotActions()
    setContent {
      MaterialTheme {
        SnapshotsDashboard(
          actions = actions,
          configClient = FakeDeviceSnapshotConfigClient(),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("Capture").performClick()

    // The capture runs on Dispatchers.IO, which waitForIdle() does not join -- poll instead so
    // this can't pass or fail on timing.
    waitUntil(timeoutMillis = ACTION_TIMEOUT_MS) { actions.listSnapshots().size == 1 }
  }

  @Test
  fun `restore routes the selected snapshot name through the actions`() = runComposeUiTest {
    val actions = FakeDeviceSnapshotActions(listOf(snapshot("nightly")))
    setContent {
      MaterialTheme {
        SnapshotsDashboard(
          actions = actions,
          configClient = FakeDeviceSnapshotConfigClient(),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("Restore").performClick()

    waitUntil(timeoutMillis = ACTION_TIMEOUT_MS) { actions.restoredSnapshotName == "nightly" }
  }

  private companion object {
    const val ACTION_TIMEOUT_MS = 5_000L
  }
}
