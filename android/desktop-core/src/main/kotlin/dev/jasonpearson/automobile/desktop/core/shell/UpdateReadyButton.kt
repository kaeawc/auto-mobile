package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.SystemUpdateAlt
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.theme.DesktopTypography
import dev.jasonpearson.automobile.desktop.core.update.UpdateStatus
import java.awt.Desktop
import java.net.URI

private val LOG = LoggerFactory.getLogger("UpdateReadyButton")

/** Opens [url] in the user's default browser. Best-effort — a failure is logged, not surfaced. */
fun openReleaseNotesInBrowser(url: String) {
  try {
    Desktop.getDesktop().browse(URI(url))
  } catch (error: Exception) {
    LOG.warn("Failed to open release notes $url: ${error.message}", error)
  }
}

/**
 * The status-bar affordance that appears only when an update is available. Pure: it renders from
 * [status] and calls [onClick]; it performs no network work and does not reach into the DI graph
 * (the shell observes the controller and passes state down). Uses Material's `secondaryContainer` /
 * `onSecondaryContainer` pair so text and icon meet contrast in both light and dark themes.
 */
@Composable
fun UpdateReadyButton(
  status: UpdateStatus,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  // Only a genuine update surfaces the pill; every other state stays silent.
  if (status !is UpdateStatus.UpdateAvailable) return

  Row(
    modifier =
      modifier
        .clip(RoundedCornerShape(4.dp))
        .clickable(onClick = onClick)
        .background(MaterialTheme.colorScheme.secondaryContainer)
        .padding(horizontal = 6.dp, vertical = 1.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    Icon(
      imageVector = Icons.Filled.SystemUpdateAlt,
      contentDescription = null,
      tint = MaterialTheme.colorScheme.onSecondaryContainer,
      modifier = Modifier.width(12.dp),
    )
    Text(
      text = "Update ready",
      style = DesktopTypography.label,
      color = MaterialTheme.colorScheme.onSecondaryContainer,
      lineHeight = 10.sp,
    )
  }
}

/**
 * The compact details surface shown when the update pill is clicked: the available version, the
 * running version, a link to the release notes, and an "Install & restart" action. The action is
 * enabled only when [onInstall] is non-null — the shell passes a callback only for packaging that
 * can apply in place (a Conveyor package), and `null` for the GitHub-Releases path, which can only
 * surface the release. Pure content — the shell wraps it in a Popup.
 */
@Composable
fun UpdateDetailsContent(
  update: UpdateStatus.UpdateAvailable,
  currentVersion: String,
  onOpenReleaseNotes: () -> Unit,
  modifier: Modifier = Modifier,
  onInstall: (() -> Unit)? = null,
) {
  Column(
    modifier = modifier.padding(12.dp),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Text(text = "Version ${update.version} is available", fontSize = 13.sp)
    Text(
      text = "You're on $currentVersion",
      fontSize = 11.sp,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    if (update.releaseNotesUrl != null) {
      TextButton(onClick = onOpenReleaseNotes) { Text("Release notes") }
    }

    Row(verticalAlignment = Alignment.CenterVertically) {
      // Enabled only when the shell supplies an install callback (a Conveyor package can apply in
      // place); the GitHub-Releases path passes null and the action stays disabled.
      TextButton(onClick = onInstall ?: {}, enabled = onInstall != null) {
        Icon(
          imageVector = Icons.Filled.Download,
          contentDescription = null,
          modifier = Modifier.width(14.dp),
        )
        Spacer(Modifier.width(4.dp))
        Text("Install & restart")
      }
    }
  }
}

/**
 * A self-contained "update ready" affordance for the surfaces that have no top bar to host the pill
 * — the device picker and onboarding (#5271). The workspace keeps its integrated top-bar pill
 * (#5225 maintainer decision); this gives the launch surfaces the same reachability so a user who
 * never observes a device still sees that an update is waiting.
 *
 * It overlays a [fillMaxSize] parent and pins itself to the bottom-end corner, clear of the
 * picker's title (top-start) and Close control (top-end) and of onboarding's centered column — so
 * placement is intentional and collision-free rather than fighting per-surface chrome. Clicking the
 * pill toggles the same [UpdateDetailsContent] used by the workspace popup, expanded just above the
 * pill.
 *
 * Pure: it renders from [status] and the passed callbacks and owns only its local expand/collapse
 * state; nothing is silenced unless [status] is not [UpdateStatus.UpdateAvailable].
 */
@Composable
fun FloatingUpdateAffordance(
  status: UpdateStatus,
  currentVersion: String,
  onOpenReleaseNotes: () -> Unit,
  modifier: Modifier = Modifier,
  onInstall: (() -> Unit)? = null,
) {
  // Only a genuine update surfaces the affordance; every other state renders nothing at all.
  val update = status as? UpdateStatus.UpdateAvailable ?: return
  var showDetails by remember { mutableStateOf(false) }

  Box(modifier = modifier.fillMaxSize()) {
    Column(
      modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
      horizontalAlignment = Alignment.End,
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      // The details card expands directly above the pill so the affordance reads as one control
      // anchored to its trigger, rather than a popup floating in from a window corner.
      if (showDetails) {
        Surface(
          shape = RoundedCornerShape(6.dp),
          color = MaterialTheme.colorScheme.surface,
          shadowElevation = 8.dp,
        ) {
          UpdateDetailsContent(
            update = update,
            currentVersion = currentVersion,
            onOpenReleaseNotes = onOpenReleaseNotes,
            onInstall = onInstall,
          )
        }
      }
      UpdateReadyButton(status = update, onClick = { showDetails = !showDetails })
    }
  }
}
