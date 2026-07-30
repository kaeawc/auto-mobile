package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
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
}
