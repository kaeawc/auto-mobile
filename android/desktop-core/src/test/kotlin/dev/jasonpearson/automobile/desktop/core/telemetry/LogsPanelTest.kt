package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.FakeTelemetryPushClient
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class LogsPanelTest {

  private fun log(level: Int, tag: String, message: String, timestamp: Long) =
    TelemetryDisplayEvent.Log(
      timestamp = timestamp,
      level = level,
      tag = tag,
      message = message,
    )

  // -- Pure filter tests (no Compose) --

  @Test
  fun `logLevelOf maps android levels to canonical buckets`() {
    assertEquals(LogLevel.Verbose, logLevelOf(2))
    assertEquals(LogLevel.Debug, logLevelOf(3))
    assertEquals(LogLevel.Info, logLevelOf(4))
    assertEquals(LogLevel.Warn, logLevelOf(5))
    assertEquals(LogLevel.Error, logLevelOf(6))
    // Assert (7) and anything above fold into Error so every row maps to a chip.
    assertEquals(LogLevel.Error, logLevelOf(7))
    // Unknown/low values fall back to Verbose so nothing is silently dropped.
    assertEquals(LogLevel.Verbose, logLevelOf(0))
  }

  @Test
  fun `empty filter shows every log`() {
    val logs =
      listOf(
        log(4, "A", "info message", 1),
        log(5, "B", "warn message", 2),
        log(6, "C", "error message", 3),
      )
    val result = filterLogs(logs, LogLevel.entries.toSet(), "")
    assertEquals(logs, result)
  }

  @Test
  fun `search narrows by case-insensitive substring over tag and message`() {
    val logs =
      listOf(
        log(4, "Network", "connected to host", 1),
        log(4, "Ui", "button tapped", 2),
        log(4, "Db", "NETWORK cache miss", 3),
      )
    // Matches tag of row 0 and message of row 2 (case-insensitive), not row 1.
    val result = filterLogs(logs, LogLevel.entries.toSet(), "network")
    assertEquals(listOf(logs[0], logs[2]), result)
  }

  @Test
  fun `disabling a level hides only that level`() {
    val logs =
      listOf(
        log(4, "A", "info message", 1),
        log(5, "B", "warn message", 2),
        log(6, "C", "error message", 3),
      )
    val result = filterLogs(logs, LogLevel.entries.toSet() - LogLevel.Warn, "")
    assertEquals(listOf(logs[0], logs[2]), result)
  }

  @Test
  fun `level and search compose together`() {
    val logs =
      listOf(
        log(4, "A", "keep me", 1),
        log(5, "B", "keep me", 2),
        log(4, "C", "drop me", 3),
      )
    val result = filterLogs(logs, setOf(LogLevel.Info), "keep")
    assertEquals(listOf(logs[0]), result)
  }

  @Test
  fun `appendBounded keeps only the most recent rows past the cap`() {
    val buffer = mutableListOf<TelemetryDisplayEvent.Log>()
    val max = 5
    for (i in 0 until 12) {
      appendBounded(buffer, log(4, "T", "m$i", i.toLong()), max)
    }
    // Only the most recent `max` rows survive, oldest dropped first.
    assertEquals(max, buffer.size)
    assertEquals(listOf("m7", "m8", "m9", "m10", "m11"), buffer.map { it.message })

    // Filtering still works over the bounded buffer (substring "m1" matches m10 and m11).
    val filtered = filterLogs(buffer, LogLevel.entries.toSet(), "m1")
    assertEquals(listOf("m10", "m11"), filtered.map { it.message })
  }

  @Test
  fun `logLevelOf buckets ios levels on the ios scale`() {
    assertEquals(LogLevel.Verbose, logLevelOf(0, LogPlatform.Ios))
    assertEquals(LogLevel.Debug, logLevelOf(1, LogPlatform.Ios))
    assertEquals(LogLevel.Info, logLevelOf(2, LogPlatform.Ios))
    assertEquals(LogLevel.Warn, logLevelOf(3, LogPlatform.Ios))
    assertEquals(LogLevel.Error, logLevelOf(4, LogPlatform.Ios))
    // iOS fault (5) is the top severity → Error.
    assertEquals(LogLevel.Error, logLevelOf(5, LogPlatform.Ios))
    // The same int buckets differently per platform: 5 = Warn on Android, Error (fault) on iOS.
    assertEquals(LogLevel.Warn, logLevelOf(5, LogPlatform.Android))
  }

  @Test
  fun `filterLogs buckets ios rows on the ios scale`() {
    val logs = listOf(log(3, "T", "ios warning", 1), log(5, "T", "ios fault", 2))
    // On the iOS scale level 3 = Warn and level 5 = Error (fault).
    assertEquals(listOf(logs[0]), filterLogs(logs, setOf(LogLevel.Warn), "", LogPlatform.Ios))
    assertEquals(listOf(logs[1]), filterLogs(logs, setOf(LogLevel.Error), "", LogPlatform.Ios))
  }

  // -- Compose UI tests --

  @Test
  fun `search field narrows the visible rows and clearing restores them`() = runComposeUiTest {
    val fake = FakeTelemetryPushClient()
    setContent {
      MaterialTheme { LogsPanel(telemetryPushClient = fake, activeDeviceId = "dev-1") }
    }
    waitForIdle()
    fake.emitEvent(log(4, "Net", "alpha connected", 10))
    fake.emitEvent(log(4, "Ui", "beta tapped", 20))
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("alpha connected").fetchSemanticsNodes().isNotEmpty() &&
        onAllNodesWithText("beta tapped").fetchSemanticsNodes().isNotEmpty()
    }

    // Typing a query hides the non-matching row.
    onNode(hasSetTextAction()).performTextInput("alpha")
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("beta tapped").fetchSemanticsNodes().isEmpty()
    }
    onNodeWithText("alpha connected").assertIsDisplayed()

    // Clearing the query restores all rows.
    onNode(hasSetTextAction()).performTextClearance()
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("beta tapped").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("alpha connected").assertIsDisplayed()
    onNodeWithText("beta tapped").assertIsDisplayed()
  }

  @Test
  fun `toggling a level chip off hides logs of that level`() = runComposeUiTest {
    val fake = FakeTelemetryPushClient()
    setContent {
      MaterialTheme { LogsPanel(telemetryPushClient = fake, activeDeviceId = "dev-1") }
    }
    waitForIdle()
    fake.emitEvent(log(4, "Net", "info line", 10))
    fake.emitEvent(log(5, "Net", "warn line", 20))
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("info line").fetchSemanticsNodes().isNotEmpty() &&
        onAllNodesWithText("warn line").fetchSemanticsNodes().isNotEmpty()
    }

    // Turning off the Warn chip hides the warn row but keeps the info row.
    onNodeWithContentDescription("Toggle Warn logs").performClick()
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("warn line").fetchSemanticsNodes().isEmpty()
    }
    onNodeWithText("info line").assertIsDisplayed()

    // Turning it back on restores the warn row.
    onNodeWithContentDescription("Toggle Warn logs").performClick()
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("warn line").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("warn line").assertIsDisplayed()
  }

  @Test
  fun `shows empty state before any logs arrive`() = runComposeUiTest {
    setContent {
      MaterialTheme { LogsPanel(telemetryPushClient = null, activeDeviceId = "dev-1") }
    }
    onNodeWithText("No logs yet").assertIsDisplayed()
  }

  @Test
  fun `level chip exposes a selected state that flips when toggled`() = runComposeUiTest {
    setContent {
      MaterialTheme { LogsPanel(telemetryPushClient = null, activeDeviceId = "dev-1") }
    }
    // Chips start enabled (selected); toggling off flips selected to false, toggling on restores
    // it.
    onNodeWithContentDescription("Toggle Warn logs").assertIsSelected()
    onNodeWithContentDescription("Toggle Warn logs").performClick()
    onNodeWithContentDescription("Toggle Warn logs").assertIsNotSelected()
    onNodeWithContentDescription("Toggle Warn logs").performClick()
    onNodeWithContentDescription("Toggle Warn logs").assertIsSelected()
  }

  @Test
  fun `surfaces a connection banner instead of a misleading no-logs-yet`() = runComposeUiTest {
    val fake = FakeTelemetryPushClient()
    setContent {
      MaterialTheme { LogsPanel(telemetryPushClient = fake, activeDeviceId = "dev-1") }
    }
    fake.setConnectionState(ConnectionState.Connecting)
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("Connecting...").fetchSemanticsNodes().isNotEmpty()
    }
    // The connecting status is surfaced; the healthy-but-empty text is not shown.
    onNodeWithText("No logs yet").assertDoesNotExist()
  }

  @Test
  fun `tail-follow survives filtering to an old row then clearing`() = runComposeUiTest {
    val fake = FakeTelemetryPushClient()
    setContent {
      MaterialTheme {
        // Constrain height so the row list overflows and scroll position actually matters.
        Box(Modifier.height(120.dp)) {
          LogsPanel(telemetryPushClient = fake, activeDeviceId = "dev-1")
        }
      }
    }
    waitForIdle()
    for (i in 0 until 30) {
      fake.emitEvent(log(4, "T", "row $i", i.toLong()))
    }
    // Following the tail, the newest row is visible.
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("row 29").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("row 29").assertIsDisplayed()

    // Filter down to an old row, then clear the query.
    onNode(hasSetTextAction()).performTextInput("row 0")
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("row 0").fetchSemanticsNodes().isNotEmpty()
    }
    onNode(hasSetTextAction()).performTextClearance()
    waitForIdle()

    // The next live row is still followed to the bottom, not stranded below the fold.
    fake.emitEvent(log(4, "T", "row 30", 30L))
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("row 30").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("row 30").assertIsDisplayed()
  }

  @Test
  fun `tail-follow keeps following once the buffer is at its cap`() = runComposeUiTest {
    val fake = FakeTelemetryPushClient()
    setContent {
      MaterialTheme {
        Box(Modifier.height(120.dp)) {
          // Tiny cap so the buffer pins quickly and `filtered.size` stops changing on append.
          LogsPanel(telemetryPushClient = fake, activeDeviceId = "dev-1", maxRows = 4)
        }
      }
    }
    waitForIdle()
    for (i in 0 until 10) {
      fake.emitEvent(log(4, "T", "row $i", i.toLong()))
    }
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("row 9").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("row 9").assertIsDisplayed()

    // Buffer is pinned at 4 rows now; the next append does not change filtered.size, but the
    // newest row must still be followed (regression guard for the size-keyed follow effect).
    fake.emitEvent(log(4, "T", "row 10", 10L))
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("row 10").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("row 10").assertIsDisplayed()
  }

  @Test
  fun `changing platform re-buckets rows without going stale`() = runComposeUiTest {
    val fake = FakeTelemetryPushClient()
    val platform = mutableStateOf(LogPlatform.Android)
    setContent {
      MaterialTheme {
        LogsPanel(
          telemetryPushClient = fake,
          activeDeviceId = "dev-1",
          platform = platform.value,
        )
      }
    }
    waitForIdle()
    fake.emitEvent(log(5, "T", "level five", 1))
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("level five").fetchSemanticsNodes().isNotEmpty()
    }

    // On the Android scale level 5 = Warn, so disabling Warn hides the row.
    onNodeWithContentDescription("Toggle Warn logs").performClick()
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("level five").fetchSemanticsNodes().isEmpty()
    }

    // Flipping to iOS after first composition must re-bucket: level 5 = fault → Error (Warn still
    // off), so the row reappears — proving the derived filter is not stale on `platform`.
    runOnIdle { platform.value = LogPlatform.Ios }
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("level five").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("level five").assertIsDisplayed()
  }

  @Test
  fun `switching device resets the log buffer`() = runComposeUiTest {
    val fake = FakeTelemetryPushClient()
    val deviceId = mutableStateOf("dev-1")
    setContent {
      MaterialTheme {
        LogsPanel(telemetryPushClient = fake, activeDeviceId = deviceId.value)
      }
    }
    waitForIdle()
    fake.emitEvent(log(4, "T", "device one row", 1))
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("device one row").fetchSemanticsNodes().isNotEmpty()
    }

    // Switching devices must clear the per-device buffer (and re-arm the collect against the new
    // device), so the previous device's rows disappear and the empty state returns.
    runOnIdle { deviceId.value = "dev-2" }
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("device one row").fetchSemanticsNodes().isEmpty()
    }
    onNodeWithText("No logs yet").assertIsDisplayed()
  }

  @Test
  fun `switching device after scrolling up still auto-follows on the new device`() =
    runComposeUiTest {
      val fake = FakeTelemetryPushClient()
      val deviceId = mutableStateOf("dev-A")
      setContent {
        MaterialTheme {
          Box(Modifier.height(120.dp)) {
            LogsPanel(telemetryPushClient = fake, activeDeviceId = deviceId.value)
          }
        }
      }
      waitForIdle()
      for (i in 0 until 30) {
        fake.emitEvent(log(4, "A", "a-row $i", i.toLong()))
      }
      waitUntil(timeoutMillis = 2_000) {
        onAllNodesWithText("a-row 29").fetchSemanticsNodes().isNotEmpty()
      }
      // Scroll device A away from the tail so its follow intent is cleared. Target the log list's
      // scroll action specifically (the chip row is also horizontally scrollable).
      onNode(hasScrollToIndexAction()).performScrollToIndex(0)
      waitUntil(timeoutMillis = 2_000) {
        onAllNodesWithText("a-row 0").fetchSemanticsNodes().isNotEmpty()
      }

      // Switch to a fresh device: its list state and follow intent must reset, so its own new
      // logs auto-follow rather than inheriting device A's scrolled-up position.
      runOnIdle { deviceId.value = "dev-B" }
      waitForIdle()
      for (i in 0 until 30) {
        fake.emitEvent(log(4, "B", "b-row $i", (100 + i).toLong()))
      }
      waitUntil(timeoutMillis = 2_000) {
        onAllNodesWithText("b-row 29").fetchSemanticsNodes().isNotEmpty()
      }
      onNodeWithText("b-row 29").assertIsDisplayed()
    }
}
