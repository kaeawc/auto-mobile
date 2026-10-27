package dev.jasonpearson.automobile.demos

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentButton
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentCard
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentOutlinedButton
import dev.jasonpearson.automobile.design.system.components.AutoMobileTopAppBar
import dev.jasonpearson.automobile.sdk.TrackRecomposition
import dev.jasonpearson.automobile.sdk.failures.AutoMobileFailures

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BugReproScreen(onNavigateBack: () -> Unit) {
  TrackRecomposition(id = "screen.demo.bug.repro", composableName = "BugReproScreen") {
    val state = remember { BugReproState() }

    Scaffold(
      topBar = {
        AutoMobileTopAppBar(
          title = { Text(text = "Bug Reproduction Demo") },
          navigationIcon = {
            IconButton(
              onClick = onNavigateBack,
              modifier = Modifier.semantics { testTag = "bug_repro_back" },
            ) {
              Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "Back",
              )
            }
          },
        )
      },
    ) { paddingValues ->
      BugReproContent(paddingValues, state)
    }
  }
}

@Composable
private fun BugStatusCard(state: BugReproState) {
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth().semantics { testTag = "bug_repro_status_card" },
    elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
  ) {
    Column(
      modifier = Modifier.fillMaxWidth().padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(
        text = "Expected count: ${state.expectedCount}",
        modifier = Modifier.semantics { testTag = "bug_repro_expected" },
      )
      Text(
        text = "Displayed count: ${state.displayedCount}",
        modifier = Modifier.semantics { testTag = "bug_repro_displayed" },
      )
      Text(
        text = "Status: ${state.statusMessage}",
        modifier = Modifier.semantics { testTag = "bug_repro_status" },
      )
    }
  }
}

@Composable
private fun NonFatalErrorButton(state: BugReproState) {
  // Non-fatal error button
  AutoMobileContentOutlinedButton(
    onClick = {
      try {
        throw IllegalStateException(
          "Intentional non-fatal error from Bug Reproduction screen",
        )
      } catch (e: IllegalStateException) {
        AutoMobileFailures.recordHandledException(
          e,
          "User triggered non-fatal error from BugReproScreen",
          "BugReproScreen",
        )
        state.nonFatalCount++
        state.errorStatusMessage = "Non-fatal error recorded: IllegalStateException"
      }
    },
    modifier = Modifier.fillMaxWidth().semantics { testTag = "trigger_nonfatal_error" },
  ) {
    Text("Trigger Non-Fatal Error")
  }
}

@Composable
private fun AnrButton(state: BugReproState) {
  // ANR button (blocks main thread)
  AutoMobileContentButton(
    onClick = {
      state.errorStatusMessage = "Triggering ANR (blocking main thread for 6 seconds)..."
      // Block the main thread for 6 seconds to trigger ANR
      // ANR threshold is typically 5 seconds for input events
      Thread.sleep(6000)
      state.errorStatusMessage = "ANR triggered (if system detected it)"
    },
    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.tertiary),
    modifier = Modifier.fillMaxWidth().semantics { testTag = "trigger_anr" },
  ) {
    Text("Trigger ANR (6s Block)")
  }
}

@Composable
private fun CrashButton(state: BugReproState) {
  // Crash button
  AutoMobileContentButton(
    onClick = {
      state.errorStatusMessage = "Crashing app..."
      // Throw an uncaught exception to crash the app
      throw RuntimeException("Intentional crash from Bug Reproduction screen")
    },
    colors =
      ButtonDefaults.buttonColors(
        containerColor = Color(0xFFB71C1C), // Dark red for danger
      ),
    modifier = Modifier.fillMaxWidth().semantics { testTag = "trigger_crash" },
  ) {
    Text("Trigger Crash", color = Color.White)
  }
}

@Composable
private fun ErrorStatusCard(state: BugReproState) {
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth().semantics { testTag = "error_status_card" },
    elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
  ) {
    Column(
      modifier = Modifier.fillMaxWidth().padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(
        text = "Non-fatal errors recorded: ${state.nonFatalCount}",
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.semantics { testTag = "error_nonfatal_count" },
      )
      Text(
        text = state.errorStatusMessage,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.semantics { testTag = "error_status_message" },
      )
    }
  }
}

@Composable
private fun BugControls(state: BugReproState) {
  // === UI Bug Section ===
  Text(
    text = "UI Bug Demo",
    style = MaterialTheme.typography.titleMedium,
  )
  Text(
    text = "Enable the bug, then tap Add Item to reproduce.",
    style = MaterialTheme.typography.bodyMedium,
  )

  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(text = "Enable Bug", modifier = Modifier.weight(1f))
    Switch(
      checked = state.bugEnabled,
      onCheckedChange = { state.bugEnabled = it },
      modifier = Modifier.semantics { testTag = "bug_repro_toggle" },
    )
  }

  BugStatusCard(state)

  Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
    AutoMobileContentButton(
      onClick = {
        state.expectedCount += 1
        if (!state.bugEnabled) {
          state.displayedCount += 1
          state.statusMessage = "Updated"
        } else {
          state.statusMessage = "Bug triggered: UI did not update"
        }
      },
      modifier = Modifier.semantics { testTag = "bug_repro_add" },
    ) {
      Text("Add Item")
    }
    AutoMobileContentButton(
      onClick = {
        state.expectedCount = 0
        state.displayedCount = 0
        state.statusMessage = "Reset"
      },
      modifier = Modifier.semantics { testTag = "bug_repro_reset" },
    ) {
      Text("Reset")
    }
  }
}

@Composable
private fun BugReproContent(
  paddingValues: androidx.compose.foundation.layout.PaddingValues,
  state: BugReproState,
) {
  Column(
    modifier =
      Modifier.fillMaxSize()
        .padding(paddingValues)
        .padding(16.dp)
        .verticalScroll(rememberScrollState())
        .semantics { testTag = "bug_repro_content" },
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    BugControls(state)

    Spacer(modifier = Modifier.height(16.dp))

    // === Error Simulation Section ===
    Text(
      text = "Error Simulation",
      style = MaterialTheme.typography.titleMedium,
    )
    Text(
      text = "Trigger crashes, ANRs, and non-fatal errors to test SDK capture.",
      style = MaterialTheme.typography.bodyMedium,
    )

    ErrorStatusCard(state)

    NonFatalErrorButton(state)

    AnrButton(state)

    CrashButton(state)

    Text(
      text = "⚠️ Crash button will terminate the app. ANR button will freeze the UI.",
      style = MaterialTheme.typography.bodySmall,
      color = MaterialTheme.colorScheme.error,
    )
  }
}

private class BugReproState {
  var expectedCount by mutableIntStateOf(0)
  var displayedCount by mutableIntStateOf(0)
  var bugEnabled by mutableStateOf(false)
  var statusMessage by mutableStateOf("Idle")
  var nonFatalCount by mutableIntStateOf(0)
  var errorStatusMessage by mutableStateOf("No errors triggered")
}
