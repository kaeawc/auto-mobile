package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.SystemUpdateAlt
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.theme.DesktopTypography
import dev.jasonpearson.automobile.desktop.core.update.UpdateStatus
import java.awt.Desktop
import java.net.URI

/** Accent used for the update affordance — a calm green that reads as "good news, optional". */
private val UpdateAccent = Color(0xFF4CAF50)

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
 * The lower-left status-bar affordance that appears only when an update is available. Pure: it
 * renders from [status] and calls [onClick]; it performs no network work and does not reach into
 * the DI graph (the shell observes the controller and passes state down).
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
        .background(UpdateAccent.copy(alpha = 0.15f))
        .padding(horizontal = 6.dp, vertical = 1.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    Icon(
      imageVector = Icons.Filled.SystemUpdateAlt,
      contentDescription = null,
      tint = UpdateAccent,
      modifier = Modifier.width(12.dp),
    )
    Text(
      text = "Update ready",
      style = DesktopTypography.label,
      color = UpdateAccent,
      lineHeight = 10.sp,
    )
  }
}

/**
 * The compact details surface shown when the update pill is clicked: the available version, the
 * running version, a link to the release notes, and a (disabled here) install action delivered by a
 * later item. Pure content — the shell wraps it in a Popup.
 */
@Composable
fun UpdateDetailsContent(
  update: UpdateStatus.UpdateAvailable,
  currentVersion: String,
  onOpenReleaseNotes: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Column(
    modifier = modifier.padding(12.dp),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Text(text = "Version ${update.version} is available", fontSize = 13.sp)
    Text(text = "You're on $currentVersion", fontSize = 11.sp, color = Color.Gray)

    if (update.releaseNotesUrl != null) {
      TextButton(onClick = onOpenReleaseNotes) { Text("Release notes") }
    }

    Row(verticalAlignment = Alignment.CenterVertically) {
      // Applying the update (download + install + restart) is delivered by a later item, so the
      // action is present but not yet enabled.
      TextButton(onClick = {}, enabled = false) {
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
