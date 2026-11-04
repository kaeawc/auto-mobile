package dev.jasonpearson.automobile.desktop.core.workspace.picker

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrapState

private val Done = Color(0xFF51CF66)

/** The first-run basics, in the order a new user reaches them on the device picker. */
enum class BasicsStep(val label: String) {
  DaemonReady("AutoMobile daemon is ready"),
  DeviceVisible("A booted device is visible"),
  DeviceObserved("A device is observed"),
}

data class BasicsChecklistItem(val step: BasicsStep, val done: Boolean)

/**
 * Derives the basics checklist from state the picker already has; nothing here is tracked
 * separately, so a step unticks again if its condition stops holding (e.g. the daemon fails).
 * - Daemon ready: the bootstrap reported Ready, or — on a transport the app doesn't bootstrap
 *   ([DaemonBootstrapState.Inactive]) or before the first pass reports — the device list loaded.
 * - Device visible: the loaded list has at least one booted (observable) device.
 * - Device observed: the caller has a non-empty workspace to return to.
 */
fun basicsChecklist(
  bootstrap: DaemonBootstrapState,
  picker: DevicePickerUiState,
  deviceObserved: Boolean,
): List<BasicsChecklistItem> {
  val loaded = picker as? DevicePickerUiState.Content
  val daemonReady =
    when (bootstrap) {
      is DaemonBootstrapState.Ready -> true
      DaemonBootstrapState.Inactive,
      DaemonBootstrapState.Unknown -> loaded != null
      is DaemonBootstrapState.Working,
      is DaemonBootstrapState.Failed -> false
    }
  val deviceVisible = loaded?.devices?.any { it.state == DeviceState.Booted } == true
  return listOf(
    BasicsChecklistItem(BasicsStep.DaemonReady, daemonReady),
    BasicsChecklistItem(BasicsStep.DeviceVisible, deviceVisible),
    BasicsChecklistItem(BasicsStep.DeviceObserved, deviceObserved),
  )
}

/** Dismissible card listing [items]; [onDismiss] hides it for good (the host persists that). */
@Composable
fun BasicsChecklistCard(
  items: List<BasicsChecklistItem>,
  onDismiss: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val doneCount = items.count { it.done }
  Column(
    modifier
      .fillMaxWidth()
      .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp))
      .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(6.dp))
      .padding(12.dp),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Text(
        "Getting started ($doneCount/${items.size})",
        style = MaterialTheme.typography.titleSmall,
        fontWeight = FontWeight.SemiBold,
      )
      Spacer(Modifier.weight(1f))
      Text(
        "Dismiss",
        color = MaterialTheme.colorScheme.primary,
        modifier =
          Modifier.clickable(onClick = onDismiss).semantics {
            contentDescription = "Dismiss getting started checklist"
          },
      )
    }
    items.forEach { item ->
      Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier =
          Modifier.semantics(mergeDescendants = true) {
            contentDescription = "${item.step.label}: ${if (item.done) "done" else "not yet"}"
          },
      ) {
        Text(
          if (item.done) "✓" else "○",
          color = if (item.done) Done else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.width(8.dp))
        Text(
          item.step.label,
          style = MaterialTheme.typography.bodyMedium,
          color =
            if (item.done) MaterialTheme.colorScheme.onSurfaceVariant
            else MaterialTheme.colorScheme.onSurface,
        )
      }
    }
  }
}
